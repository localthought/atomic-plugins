#!/usr/bin/env ruby
# frozen_string_literal: true

require 'json'
require 'yaml'

source_dir = ARGV.fetch(0)
target_dir = File.expand_path('../moneybird.com/api/v2', __dir__)
document = YAML.load_file(File.join(source_dir, 'openapi.yaml'))
inventory = JSON.parse(File.read(File.join(source_dir, 'collections.json'))).fetch('collections')

singular = {
  'contacts' => 'contact', 'identities' => 'identity', 'tax_rates' => 'tax_rate',
  'users' => 'user', 'verifications' => 'verification', 'contact_additional_charges' => 'contact_additional_charge',
  'subscription_additional_charges' => 'subscription_additional_charge'
}
resource_name = ->(name) { singular.fetch(name, name.sub(/s\z/, '')) }

resources = {}
actions = []
inventory.each do |entry|
  resource = resource_name.call(entry.fetch('name'))
  model = { 'schema' => { '$ref' => "#/components/schemas/#{entry.fetch('schema')}" } }
  if entry['response_is_array']
    if entry['detail_path']
      model['identity'] = {
        'urlTemplate' => entry['detail_path'],
        'bindings' => { entry.fetch('identity_field') => { 'field' => entry.fetch('identity_field') } }
      }
    end
    model['collections'] = { entry.fetch('name') => { 'urlTemplate' => entry.fetch('path') } }
    action = { 'action' => 'list', 'resource' => resource, 'collection' => entry.fetch('name') }
  else
    model['identity'] = { 'urlTemplate' => entry.fetch('path') }
    action = { 'action' => 'read', 'resource' => resource }
  end
  resources[resource] = model
  actions << { 'target' => "$.paths['#{entry.fetch('path')}'].get", 'update' => { 'x-crud' => action } }
  if entry['detail_path']
    actions << { 'target' => "$.paths['#{entry.fetch('detail_path')}'].get", 'update' => { 'x-crud' => { 'action' => 'read', 'resource' => resource } } }
  end
end

# Object records reachable from collection items but not represented as collections.
{
  'moneybird_payments_mandate' => ['recurring_contract_response', '/{administration_id}/contacts/{contact_id}/moneybird_payments_mandate.json'],
}.each do |resource, (schema, path)|
  resources[resource] = { 'schema' => { '$ref' => "#/components/schemas/#{schema}" }, 'identity' => { 'urlTemplate' => path } }
  actions << { 'target' => "$.paths['#{path}'].get", 'update' => { 'x-crud' => { 'action' => 'read', 'resource' => resource } } }
end

crud = {
  'overlay' => '1.0.0',
  'info' => { 'title' => 'Moneybird Readable Record Resource Model', 'version' => '1.0.0' },
  'actions' => [{ 'target' => '$.components', 'update' => { 'crudResources' => resources } }] + actions
}

pagination_actions = inventory.map do |entry|
  next unless entry.dig('pagination', 'page')
  { 'target' => "$.paths['#{entry.fetch('path')}'].get", 'update' => { 'x-pagination' => [{ 'scheme' => 'pageNumber' }] } }
end.compact
pagination = {
  'overlay' => '1.0.0',
  'info' => { 'title' => 'Moneybird API Pagination Schemes', 'version' => '1.0.0' },
  'actions' => [{
    'target' => '$.components',
    'update' => { 'paginationSchemes' => { 'pageNumber' => {
      'type' => 'pageNumber',
      'request' => { 'queryParameters' => { 'page' => { 'role' => 'page' }, 'per_page' => { 'role' => 'pageSize' } } }
    } } }
  }] + pagination_actions
}

links = {
  'subscriptions' => {
    'operationId' => 'get_administration_id_subscriptions',
    'parameters' => { 'path.administration_id' => '$request.path.administration_id' },
    'x-for-each' => { 'items' => '', 'parameters' => { 'query.contact_id' => '/id' } }
  },
  'additionalCharges' => {
    'operationId' => 'get_administration_id_contacts_id_additional_charges',
    'parameters' => { 'path.administration_id' => '$request.path.administration_id' },
    'x-for-each' => { 'items' => '', 'parameters' => { 'path.contact_id' => '/id' } }
  },
  'moneybirdPaymentsMandate' => {
    'operationId' => 'get_administration_id_contacts_contact_id_moneybird_payments_mandate',
    'parameters' => { 'path.administration_id' => '$request.path.administration_id' },
    'x-for-each' => { 'items' => '', 'parameters' => { 'path.contact_id' => '/id' } }
  }
}
subscription_links = {
  'additionalCharges' => {
    'operationId' => 'get_administration_id_subscriptions_id_additional_charges',
    'parameters' => { 'path.administration_id' => '$request.path.administration_id' },
    'x-for-each' => { 'items' => '', 'parameters' => { 'path.id' => '/id' } }
  }
}
crud['actions'] << { 'target' => "$.paths['/{administration_id}/contacts.json'].get.responses['200']", 'update' => { 'links' => links } }
crud['actions'] << { 'target' => "$.paths['/{administration_id}/subscriptions.json'].get.responses['200']", 'update' => { 'links' => subscription_links } }
subscription_path = '/{administration_id}/subscriptions.json'
subscription_parameters = document.fetch('paths').fetch(subscription_path).fetch('get').fetch('parameters').map do |parameter|
  if parameter.is_a?(Hash) && parameter['$ref']&.start_with?('#/components/parameters/')
    parameter = document.fetch('components').fetch('parameters').fetch(parameter['$ref'].split('/').last)
  end
  next parameter unless parameter.is_a?(Hash) && parameter['name'] == 'contact_id'
  parameter.merge('x-filter' => { 'field' => '/contact_id', 'operator' => 'eq' })
end
crud['actions'] << { 'target' => "$.paths['#{subscription_path}'].get", 'update' => { 'parameters' => subscription_parameters } }

selection_overrides = inventory.map do |entry|
  values = entry.fetch('constant_query', []).to_h { |item| [item.fetch('name'), item.fetch('value')] }
  next if values.empty?
  { 'path' => entry.fetch('path'), 'values' => values }
end.compact
selection = { 'query_overrides' => selection_overrides }

auth = {
  'overlay' => '1.0.0',
  'info' => { 'title' => 'Moneybird API Authentication Profile', 'version' => '1.0.0' },
  'actions' => [{ 'target' => '$.components.securitySchemes', 'update' => {
    'moneybirdOAuth' => { 'type' => 'oauth2', 'flows' => { 'authorizationCode' => {
      'authorizationUrl' => 'https://moneybird.com/oauth/authorize', 'tokenUrl' => 'https://moneybird.com/oauth/token',
      'scopes' => %w[sales_invoices documents estimates bank time_entries settings].to_h { |scope| [scope, "Read Moneybird #{scope.tr('_', ' ')} data."] }
    } } }
  } }]
}
document.fetch('paths').each do |path, path_item|
  operation = path_item['get']
  next unless operation
  source_security = operation.fetch('security', document.fetch('security', []))
  oauth_security = source_security.flat_map do |requirement|
    requirement.map do |_scheme, scopes|
      raise "invalid security scopes for #{path}" unless scopes.is_a?(Array) && scopes.all? { |scope| scope.is_a?(String) }

      { 'moneybirdOAuth' => scopes }
    end
  end.uniq
  auth['actions'] << {
    'target' => "$.paths['#{path}'].get",
    'update' => { 'security' => oauth_security + [{ 'bearerAuth' => [] }] }
  }
end

{
  'crud-causality-overlay.yaml' => crud,
  'pagination-overlay.yaml' => pagination,
  'auth-overlay.yaml' => auth
}.each { |name, value| File.write(File.join(target_dir, name), YAML.dump(value, line_width: -1)) }
File.write(File.join(target_dir, 'all-records-selection.json'), JSON.pretty_generate(selection) + "\n")
