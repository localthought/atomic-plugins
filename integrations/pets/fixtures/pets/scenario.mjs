/** Synthetic Pets fixtures: five read-only records, two pages via a Link header. */
export const pets = ['Rex', 'Whiskers', 'Tweety', 'Nibbles', 'Bubbles'].map(
  (name, i) => ({
    id: i + 1,
    name,
    species: ['Dog', 'Cat', 'Bird', 'Rabbit', 'Fish'][i],
    age: i + 1,
    vaccinated: i % 2 === 0,
    weight: i + 0.5,
    updated_at: '2026-09-09T00:00:00Z',
  }),
);

export function petsFixture() {
  return {
    request(method, url) {
      if (method !== 'GET') return { status: 403, body: {} };
      const second = url.searchParams.get('page') === '2';

      return {
        status: 200,
        body: second ? pets.slice(2) : pets.slice(0, 2),
        headers: url.searchParams.has('page')
          ? {}
          : { Link: '<https://pets.example/pets?page=2>; rel="next"' },
      };
    },
  };
}

export default {
  title: 'Pets',
  // Served as-is with a YAML content type, like the real proxy's overlay doc.
  documentFile: new URL('../../app/openapi.json', import.meta.url),
  create: petsFixture,
};
