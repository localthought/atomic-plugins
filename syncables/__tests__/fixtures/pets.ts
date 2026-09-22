export const petsDocument = {
  openapi: '3.0.0',
  info: { title: 'Pet Store', version: '1.0.0' },
  paths: {
    '/pets': {
      get: {
        responses: {
          '200': {
            description: 'A list of pets',
            content: {
              'application/json': {
                schema: {
                  type: 'array',
                  items: { $ref: '#/components/schemas/Pet' },
                },
              },
            },
          },
        },
      },
      post: {
        requestBody: {
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/NewPet' } },
          },
        },
        responses: {
          '201': {
            description: 'Created',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/Pet' } },
            },
          },
        },
      },
    },
    '/pets/{petId}': {
      get: {
        responses: {
          '200': {
            description: 'A pet',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/Pet' } },
            },
          },
          '404': { description: 'Not found' },
        },
      },
      put: {
        requestBody: {
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/NewPet' } },
          },
        },
        responses: {
          '200': {
            description: 'Updated',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/Pet' } },
            },
          },
        },
      },
      delete: {
        responses: {
          '204': { description: 'Deleted' },
        },
      },
    },
    '/health': {
      get: {
        responses: {
          '200': {
            description: 'Health check',
            content: {
              'application/json': { schema: { example: { status: 'ok' } } },
            },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      NewPet: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string' },
          tag: { type: 'string' },
        },
      },
      Pet: {
        allOf: [
          { $ref: '#/components/schemas/NewPet' },
          {
            type: 'object',
            properties: {
              id: { type: 'string', format: 'uuid' },
            },
          },
        ],
      },
    },
  },
};
