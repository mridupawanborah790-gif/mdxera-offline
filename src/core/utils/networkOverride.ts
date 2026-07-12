if (typeof navigator !== 'undefined') {
  const originalOnLine = Object.getOwnPropertyDescriptor(Navigator.prototype, 'onLine');
  
  Object.defineProperty(navigator, 'onLine', {
    get() {
      const mode = localStorage.getItem('networkMode') || 'auto';
      if (mode === 'online') return true;
      if (mode === 'offline') return false;
      if (originalOnLine && originalOnLine.get) {
        return originalOnLine.get.call(navigator);
      }
      return true;
    },
    configurable: true,
    enumerable: true
  });
}
export {};
