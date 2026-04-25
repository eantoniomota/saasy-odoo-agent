import { getCpuUsage, getRamUsage, getDiskUsage, getNetworkUsage, collectSystemMetrics } from '../src/collectors/system';

describe('System Collectors', () => {
  describe('getCpuUsage', () => {
    it('retourne un nombre entre 0 et 100', () => {
      // First call initializes baseline
      getCpuUsage();
      // Second call calculates delta
      const cpu = getCpuUsage();
      expect(typeof cpu).toBe('number');
      expect(cpu).toBeGreaterThanOrEqual(0);
      expect(cpu).toBeLessThanOrEqual(100);
    });
  });

  describe('getRamUsage', () => {
    it('retourne un nombre entre 0 et 100', () => {
      const ram = getRamUsage();
      expect(typeof ram).toBe('number');
      expect(ram).toBeGreaterThanOrEqual(0);
      expect(ram).toBeLessThanOrEqual(100);
    });

    it('retourne une valeur non nulle (au moins un peu de RAM est utilise)', () => {
      const ram = getRamUsage();
      expect(ram).toBeGreaterThan(0);
    });
  });

  describe('getDiskUsage', () => {
    it('retourne un nombre >= 0', () => {
      const disk = getDiskUsage();
      expect(typeof disk).toBe('number');
      expect(disk).toBeGreaterThanOrEqual(0);
    });
  });

  describe('getNetworkUsage', () => {
    it('retourne netIn et netOut >= 0', () => {
      // Initialize baseline
      getNetworkUsage();
      const { netIn, netOut } = getNetworkUsage();
      expect(typeof netIn).toBe('number');
      expect(typeof netOut).toBe('number');
      expect(netIn).toBeGreaterThanOrEqual(0);
      expect(netOut).toBeGreaterThanOrEqual(0);
    });
  });

  describe('collectSystemMetrics', () => {
    it('retourne un objet avec tous les champs', () => {
      // Initialize baselines
      collectSystemMetrics();
      const metrics = collectSystemMetrics();
      expect(metrics).toHaveProperty('cpu');
      expect(metrics).toHaveProperty('ram');
      expect(metrics).toHaveProperty('disk');
      expect(metrics).toHaveProperty('netIn');
      expect(metrics).toHaveProperty('netOut');

      expect(typeof metrics.cpu).toBe('number');
      expect(typeof metrics.ram).toBe('number');
      expect(typeof metrics.disk).toBe('number');
      expect(typeof metrics.netIn).toBe('number');
      expect(typeof metrics.netOut).toBe('number');
    });
  });
});
