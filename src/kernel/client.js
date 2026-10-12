// Promise-based wrapper around the CAD worker. Build requests are coalesced: while one build runs,
// only the newest pending request is kept, so dragging a slider never queues stale rebuilds.
export class Kernel {
  constructor() {
    this.worker = new Worker(new URL('./cad.worker.js', import.meta.url), { type: 'module' });
    this.seq = 0;
    this.pending = new Map();
    // start-up progress from the worker (for the loading screen) and a promise for "kernel ready"
    this.onBoot = null;
    this.ready = new Promise((r) => (this._ready = r));
    this.worker.onmessage = ({ data }) => {
      if (data.boot) { if (data.ready) this._ready(); else this.onBoot?.(data.p, data.text); return; }
      const p = this.pending.get(data.id);
      if (!p) return;
      this.pending.delete(data.id);
      data.ok ? p.resolve(data) : p.reject(new Error(data.error));
    };
    this.worker.onerror = (e) => console.error('CAD worker error', e);
    this.building = false;
    this.queued = null;
  }

  call(msg) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ ...msg, id });
    });
  }

  // Resolves with the result, or with null if superseded by a newer build request.
  build(features, opts = {}) {
    return new Promise((resolve, reject) => {
      if (this.queued) this.queued.resolve(null);
      this.queued = { features, opts, resolve, reject };
      this._pump();
    });
  }

  async _pump() {
    if (this.building || !this.queued) return;
    const job = this.queued;
    this.queued = null;
    this.building = true;
    try {
      const res = await this.call({ type: 'build', features: job.features, ...job.opts, have: job.opts.have?.() || [] });
      job.resolve(res);
    } catch (e) {
      job.reject(e);
    } finally {
      this.building = false;
      this._pump();
    }
  }

  props(body) { return this.call({ type: 'props', body }); }
  export(bodies, format) { return this.call({ type: 'export', bodies, format }); }
  interference(bodies) { return this.call({ type: 'interference', bodies }); }
  drawing(bodies, views, section = null) { return this.call({ type: 'drawing', bodies, views, section }); }
  measure(picks) { return this.call({ type: 'measure', picks }); }
  curvature(body) { return this.call({ type: 'curvature', body }); }
  combs(picks) { return this.call({ type: 'combs', picks }); }
  dxf(pick) { return this.call({ type: 'dxf', pick }); }
  flat(body) { return this.call({ type: 'flat', body }); }
  compare(features) { return this.call({ type: 'compare', features }); }
  cam(cam) { return this.call({ type: 'cam', cam }); }
  font(id, data) { return this.call({ type: 'font', id, data }); }
}
