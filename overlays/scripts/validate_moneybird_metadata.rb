#!/usr/bin/env ruby
# frozen_string_literal: true

require 'json'
require 'yaml'

source_dir = ARGV.fetch(0)
metadata_dir = File.expand_path('../moneybird.com/api/v2', __dir__)
document = YAML.load_file(File.join(source_dir, 'openapi.yaml'))
inventory = JSON.parse(File.read(File.join(source_dir, 'collections.json'))).fetch('collections')
overlays = Dir[File.join(metadata_dir, '*-overlay.yaml')].to_h { |path| [File.basename(path), YAML.load_file(path)] }

errors = []
operations = document.fetch('paths').values.map { |item| item['get'] }.compact
operation_ids = operations.map { |operation| operation['operationId'] }.compact
schemas = document.fetch('components').fetch('schemas')

crud = overlays.fetch('crud-causality-overlay.yaml')
resources = crud.fetch('actions').first.fetch('update').fetch('crudResources')
resources.each do |name, resource|
  ref = resource.dig('schema', '$ref')
  schema = ref&.delete_prefix('#/components/schemas/')
  errors << "#{name}: missing schema #{ref}" unless schema && schemas.key?(schema)
  resource.fetch('collections', {}).each_value do |collection|
    path = collection.fetch('urlTemplate')
    errors << "#{name}: missing collection GET #{path}" unless document.dig('paths', path, 'get')
  end
end

crud.fetch('actions').drop(1).each do |action|
  target = action.fetch('target')
  path = target[/\$\.paths\['(.+)'\]\.get/, 1]
  errors << "missing overlay target #{target}" if path && !document.dig('paths', path, 'get')
  action.dig('update', 'links')&.each do |link_name, link|
    errors << "#{link_name}: unknown operationId #{link['operationId']}" unless operation_ids.include?(link['operationId'])
  end
end

expected_collections = inventory.count { |entry| entry['response_is_array'] }
actual_collections = resources.values.sum { |resource| resource.fetch('collections', {}).length }
errors << "expected #{expected_collections} collections, found #{actual_collections}" unless actual_collections == expected_collections
%w[downloads contacts subscriptions contact_additional_charges subscription_additional_charges].each do |name|
  errors << "missing required collection #{name}" unless resources.values.any? { |resource| resource.fetch('collections', {}).key?(name) }
end
%w[verification moneybird_payments_mandate].each do |name|
  errors << "missing required object read #{name}" unless resources.key?(name)
end

auth_actions = overlays.fetch('auth-overlay.yaml').fetch('actions')
errors << 'not every GET has an authentication requirement' unless auth_actions.length - 1 == operations.length
declared_scopes = auth_actions.first.dig('update', 'moneybirdOAuth', 'flows', 'authorizationCode', 'scopes').keys.sort
expected_scopes = %w[bank documents estimates sales_invoices settings time_entries]
errors << "OAuth scopes differ: #{declared_scopes.inspect}" unless declared_scopes == expected_scopes
auth_by_target = auth_actions.drop(1).to_h { |action| [action.fetch('target'), action.dig('update', 'security')] }
document.fetch('paths').each do |path, path_item|
  operation = path_item['get']
  next unless operation

  target = "$.paths['#{path}'].get"
  actual = auth_by_target[target]
  expected_oauth = operation.fetch('security', document.fetch('security', [])).flat_map do |requirement|
    requirement.map { |_scheme, scopes| { 'moneybirdOAuth' => scopes } }
  end.uniq
  errors << "#{target}: security alternatives changed" unless actual == expected_oauth + [{ 'bearerAuth' => [] }]
  actual&.each do |requirement|
    errors << "#{target}: invalid security requirement" unless requirement.is_a?(Hash) && requirement.length == 1
    requirement&.each_value do |scopes|
      errors << "#{target}: scopes must be a flat string array" unless scopes.is_a?(Array) && scopes.all? { |scope| scope.is_a?(String) }
    end
  end
end

pagination_actions = overlays.fetch('pagination-overlay.yaml').fetch('actions').drop(1)
expected_paginated = inventory.count { |entry| entry.dig('pagination', 'page') }
errors << "expected #{expected_paginated} pagination applications, found #{pagination_actions.length}" unless pagination_actions.length == expected_paginated

selection = JSON.parse(File.read(File.join(metadata_dir, 'all-records-selection.json')))
errors << 'consumer selection profile leaked into CRUD metadata' if File.read(File.join(metadata_dir, 'crud-causality-overlay.yaml')).include?('x-list-query')
errors << 'expected six explicit consumer selections' unless selection.fetch('query_overrides').length == 6

catalog = JSON.parse(File.read(File.expand_path('../catalog.json', __dir__)))
platforms = catalog.fetch('platforms')
errors << 'catalog must preserve all six platforms' unless platforms.length == 6
errors << 'catalog platform names must remain unique' unless platforms.map { |platform| platform['name'] }.uniq.length == platforms.length
moneybird = platforms.find { |platform| platform['name'] == 'moneybird' }
errors << 'catalog is missing Moneybird' unless moneybird
if moneybird
  oad_pin = '85a6105220036a98ef0d7cd6f228d4aae0036508'
  auth_pin = '14358caa72aebef5ac32ec8a9e217e7ed3e7b6f4'
  overlay_pin = '7df9d9c6724c2d5f2d41126d7446c1021ec8e254'
  errors << 'catalog has the wrong Moneybird OAD pin' unless moneybird['openapi'].include?(oad_pin)
  errors << 'catalog has the wrong Moneybird auth pin' unless moneybird.fetch('overlays').first.include?(auth_pin)
  errors << 'catalog has an unpinned Moneybird non-auth overlay' unless moneybird.fetch('overlays').drop(1).all? { |url| url.include?(overlay_pin) }
  errors << 'consumer selection must not be composed as an overlay' if moneybird.fetch('overlays').any? { |url| url.include?('selection') }
  errors << 'catalog selection differs from reviewed consumer config' unless moneybird['selection'] == selection
end
contact = resources['contact']
errors << 'contact schema identity namespace changed' unless contact&.dig('schema', '$ref') == '#/components/schemas/contact' && contact&.dig('identity', 'urlTemplate') == '/{administration_id}/contacts/{id}.json'

forbidden = /x-import-policy|listQueryBindings|singleton:/
overlays.each do |name, overlay|
  errors << "#{name}: contains forbidden draft metadata" if YAML.dump(overlay).match?(forbidden)
end

abort(errors.join("\n")) unless errors.empty?
puts "validated #{actual_collections} collections, #{resources.length - actual_collections} object resources, #{operation_ids.length} GET operations, and #{pagination_actions.length} pagination applications"
