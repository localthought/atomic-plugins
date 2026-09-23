/** Passive mapping between issue/comment projections and Atomic resource properties. */
export const propertiesByField = {
  title: 'https://atomicdata.dev/properties/name',
  body: 'https://atomicdata.dev/task/v1/body',
  status: 'https://atomicdata.dev/task/v1/status',
};
const tag = 'https://atomicdata.dev/task/v1/';

export function properties(projection) {
  return {
    [propertiesByField.body]: projection.body,
    ...(projection.title === undefined
      ? {}
      : {
          [propertiesByField.title]: projection.title,
          [propertiesByField.status]: [
            `${tag}${projection.status.toLowerCase()}`,
          ],
        }),
  };
}
export function value(resource, entity) {
  if (entity !== 'issue') return { body: resource[propertiesByField.body] };
  const status = {
    [`${tag}todo`]: 'Todo',
    [`${tag}doing`]: 'Doing',
    [`${tag}done`]: 'Done',
  }[resource[propertiesByField.status]?.[0]];
  if (!status || resource[propertiesByField.status].length !== 1)
    throw new Error('Unsupported task status');

  return {
    title: resource[propertiesByField.title],
    body: resource[propertiesByField.body],
    status,
  };
}
