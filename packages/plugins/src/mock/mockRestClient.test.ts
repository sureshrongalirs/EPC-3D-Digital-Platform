import type { Zone } from '@plantscope/shared';
import { describe, expect, it } from 'vitest';

import { createMockRestClient } from './mockRestClient';

describe('createMockRestClient', () => {
  it('assigns an id on POST /api/zones and returns it again on GET', async () => {
    const client = createMockRestClient();
    const zone: Zone = { id: '', name: 'Pumps', color: '#f00', members: ['a'], footprint: [], zmin: 0, zmax: 1 };

    const saved = await client.post<Zone>('/api/zones', zone);
    expect(saved.id).toBeTruthy();

    const all = await client.get<Zone[]>('/api/zones');
    expect(all).toEqual([saved]);
  });

  it('deletes a zone via the POST .../delete convenience route', async () => {
    const client = createMockRestClient({
      zones: [{ id: 'z1', name: 'Z', color: '#000', members: [], footprint: [], zmin: 0, zmax: 0 }],
    });
    await client.post('/api/zones/z1/delete', {});
    expect(await client.get<Zone[]>('/api/zones')).toEqual([]);
  });

  it('rejects GET /api/components/:key for an unknown key', async () => {
    const client = createMockRestClient();
    await expect(client.get('/api/components/does-not-exist')).rejects.toThrow();
  });

  it('resolves GET /api/components/:key for a seeded component', async () => {
    const client = createMockRestClient({
      components: [{ linkageKey: 'LINK-1', moniker: 'P-101A', category: 'Pump', tagNumber: 'P-101A', status: 'In Service' }],
    });
    const record = await client.get('/api/components/LINK-1');
    expect(record).toMatchObject({ moniker: 'P-101A' });
  });
});
