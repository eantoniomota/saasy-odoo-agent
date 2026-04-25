// Mock config before importing
jest.mock('../src/config', () => ({
  config: {
    apiUrl: 'https://api.test.saasy.fr',
    apiKey: 'fbk_test_key',
    serverId: 'test-server-id',
    collectInterval: 30000,
    logFlushInterval: 10000,
    heartbeatInterval: 60000,
    dockerSocket: '/var/run/docker.sock',
    logContainers: [],
    hostname: 'test-host',
    version: '1.0.0',
  },
}));

import { sendMetrics, sendLogs, sendHeartbeat } from '../src/transport/api';

describe('API Transport', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = jest.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe('sendMetrics', () => {
    it('envoie les metriques avec les bons headers', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true }),
      });

      const result = await sendMetrics({
        serverId: 'test-server-id',
        timestamp: '2026-03-18T10:00:00.000Z',
        cpu: 45.5,
        ram: 62.3,
      });

      expect(result).toBe(true);
      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.test.saasy.fr/api/infra/v1/agent/metrics',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            'X-API-Key': 'fbk_test_key',
          }),
        }),
      );
    });

    it('retourne false sur erreur 4xx', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: false,
        status: 422,
        json: async () => ({ success: false, error: 'Validation error' }),
      });

      const result = await sendMetrics({
        serverId: 'test',
        timestamp: '2026-03-18T10:00:00.000Z',
        cpu: 45,
        ram: 62,
      });

      expect(result).toBe(false);
    });

    it('retourne false apres 3 retries sur erreur reseau', async () => {
      (global.fetch as jest.Mock).mockRejectedValue(new Error('Network error'));

      const result = await sendMetrics({
        serverId: 'test',
        timestamp: '2026-03-18T10:00:00.000Z',
        cpu: 45,
        ram: 62,
      });

      expect(result).toBe(false);
      // 1 initial + 3 retries = 4 calls
      expect(global.fetch).toHaveBeenCalledTimes(4);
    }, 30000);
  });

  describe('sendLogs', () => {
    it('retourne true quand entries est vide', async () => {
      const result = await sendLogs('test', []);
      expect(result).toBe(true);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('envoie les logs correctement', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true }),
      });

      const result = await sendLogs('test', [
        { container: 'api', timestamp: '2026-03-18T10:00:00.000Z', level: 'info', message: 'test' },
      ]);

      expect(result).toBe(true);
      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.test.saasy.fr/api/infra/v1/agent/logs',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('"serverId":"test"'),
        }),
      );
    });
  });

  describe('sendHeartbeat', () => {
    it('envoie le heartbeat correctement', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true }),
      });

      const result = await sendHeartbeat({
        serverId: 'test',
        version: '1.0.0',
        hostname: 'my-server',
        uptime: 86400,
        containers: ['api', 'nginx'],
      });

      expect(result).toBe(true);
    });
  });
});
