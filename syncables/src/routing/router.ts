export interface RouteMatch {
  template: string;
  params: Record<string, string>;
}

function matchTemplate(
  template: string,
  actual: string,
): Record<string, string> | undefined {
  const templateSegments = template.split('/').filter(Boolean);
  const actualSegments = actual.split('/').filter(Boolean);
  if (templateSegments.length !== actualSegments.length) {
    return undefined;
  }

  const params: Record<string, string> = {};
  for (const [index, templateSegment] of templateSegments.entries()) {
    const actualSegment = actualSegments[index] ?? '';
    if (templateSegment.startsWith('{') && templateSegment.endsWith('}')) {
      params[templateSegment.slice(1, -1)] = decodeURIComponent(actualSegment);
    } else if (templateSegment !== actualSegment) {
      return undefined;
    }
  }
  return params;
}

export function findRoute(
  templates: string[],
  actual: string,
): RouteMatch | undefined {
  for (const template of templates) {
    const params = matchTemplate(template, actual);
    if (params) {
      return { template, params };
    }
  }
  return undefined;
}
