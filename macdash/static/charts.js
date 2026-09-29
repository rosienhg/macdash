// Minimal canvas time-series chart with crosshair + tooltip. No dependencies.
(function () {
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  function niceMax(v) {
    if (!(v > 0)) return 1;
    const exp = Math.pow(10, Math.floor(Math.log10(v)));
    for (const m of [1, 2, 2.5, 5, 10]) if (m * exp >= v) return m * exp;
    return 10 * exp;
  }

  function timeLabel(t) {
    const d = new Date(t * 1000);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  class LineChart {
    constructor(el, opts) {
      this.el = el;
      this.opts = Object.assign({ min: 0, max: null, format: (v) => String(v), area: false }, opts);
      this.points = [];
      this.range = 900;
      this.canvas = document.createElement("canvas");
      this.tip = document.createElement("div");
      this.tip.className = "tooltip";
      this.tip.hidden = true;
      el.append(this.canvas, this.tip);
      this.hoverX = null;
      this.canvas.addEventListener("mousemove", (e) => { this.hoverX = e.offsetX; this.draw(); });
      this.canvas.addEventListener("mouseleave", () => { this.hoverX = null; this.draw(); });
      this.canvas.addEventListener("touchmove", (e) => {
        const r = this.canvas.getBoundingClientRect();
        this.hoverX = e.touches[0].clientX - r.left; this.draw();
      }, { passive: true });
      this.canvas.addEventListener("touchend", () => { this.hoverX = null; this.draw(); });
      new ResizeObserver(() => this.draw()).observe(el);
    }

    setData(points, range) {
      this.points = points;
      if (range) this.range = range;
      this.draw();
    }

    draw() {
      const { canvas, el, opts } = this;
      const dpr = window.devicePixelRatio || 1;
      const W = el.clientWidth, H = el.clientHeight;
      if (!W || !H) return;
      if (canvas.width !== W * dpr || canvas.height !== H * dpr) {
        canvas.width = W * dpr; canvas.height = H * dpr;
      }
      const ctx = canvas.getContext("2d");
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);

      const pad = { l: 44, r: 8, t: 8, b: 20 };
      const pw = W - pad.l - pad.r, ph = H - pad.t - pad.b;
      const now = this.points.length ? this.points[this.points.length - 1].t : Date.now() / 1000;
      const t0 = now - this.range;
      const pts = this.points.filter((p) => p.t >= t0);

      let ymax = opts.max;
      if (ymax == null) {
        let m = 0;
        for (const p of pts) for (const s of opts.series) { const v = p[s.key]; if (v != null && v > m) m = v; }
        ymax = niceMax(m * 1.1);
      }
      const ymin = opts.min;
      const x = (t) => pad.l + ((t - t0) / this.range) * pw;
      const y = (v) => pad.t + ph - ((v - ymin) / (ymax - ymin)) * ph;

      // grid + y labels
      ctx.font = "11px system-ui, -apple-system, sans-serif";
      ctx.fillStyle = css("--muted");
      ctx.textAlign = "right"; ctx.textBaseline = "middle";
      const ticks = 4;
      for (let i = 0; i <= ticks; i++) {
        const v = ymin + ((ymax - ymin) * i) / ticks;
        const yy = Math.round(y(v)) + 0.5;
        ctx.strokeStyle = i === 0 ? css("--axis") : css("--grid");
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(pad.l, yy); ctx.lineTo(W - pad.r, yy); ctx.stroke();
        if (i % 2 === 0) ctx.fillText(opts.format(v, true), pad.l - 6, yy);
      }
      // x labels
      ctx.textAlign = "center"; ctx.textBaseline = "top";
      const xt = 4;
      for (let i = 0; i <= xt; i++) {
        const t = t0 + (this.range * i) / xt;
        const xx = x(t);
        ctx.textAlign = i === 0 ? "left" : i === xt ? "right" : "center";
        ctx.fillText(timeLabel(t), Math.min(Math.max(xx, pad.l), W - pad.r), H - pad.b + 5);
      }

      // series (gaps where samples are missing for > 3 intervals)
      const gap = (opts.interval || 2) * 3;
      for (const s of opts.series) {
        const color = css(s.color);
        ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.lineJoin = "round";
        ctx.beginPath();
        let started = false, prevT = null;
        for (const p of pts) {
          const v = p[s.key];
          if (v == null) { started = false; continue; }
          const xx = x(p.t), yy = y(Math.min(v, ymax));
          if (!started || (prevT && p.t - prevT > gap)) { ctx.moveTo(xx, yy); started = true; }
          else ctx.lineTo(xx, yy);
          prevT = p.t;
        }
        ctx.stroke();
        if (opts.area && opts.series.length === 1 && pts.length > 1) {
          ctx.lineTo(x(pts[pts.length - 1].t), y(ymin));
          ctx.lineTo(x(pts[0].t), y(ymin));
          ctx.closePath();
          ctx.globalAlpha = 0.10; ctx.fillStyle = color; ctx.fill(); ctx.globalAlpha = 1;
        }
      }

      // crosshair + tooltip
      if (this.hoverX != null && pts.length && this.hoverX >= pad.l) {
        const tAt = t0 + ((this.hoverX - pad.l) / pw) * this.range;
        let best = pts[0];
        for (const p of pts) if (Math.abs(p.t - tAt) < Math.abs(best.t - tAt)) best = p;
        const xx = Math.round(x(best.t)) + 0.5;
        ctx.strokeStyle = css("--axis"); ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(xx, pad.t); ctx.lineTo(xx, pad.t + ph); ctx.stroke();
        const surface = css("--surface");
        let html = `<div class="muted">${new Date(best.t * 1000).toLocaleTimeString()}</div>`;
        for (const s of opts.series) {
          const v = best[s.key];
          if (v == null) continue;
          ctx.beginPath(); ctx.arc(xx, y(Math.min(v, ymax)), 4, 0, Math.PI * 2);
          ctx.fillStyle = css(s.color); ctx.fill();
          ctx.lineWidth = 2; ctx.strokeStyle = surface; ctx.stroke();
          html += `<div><span class="sw" style="background:${css(s.color)}"></span>${s.label}: <b>${opts.format(v)}</b></div>`;
        }
        this.tip.innerHTML = html;
        this.tip.hidden = false;
        const tw = this.tip.offsetWidth;
        this.tip.style.left = (xx + 12 + tw > W ? xx - tw - 12 : xx + 12) + "px";
        this.tip.style.top = pad.t + "px";
      } else {
        this.tip.hidden = true;
      }
    }
  }

  window.LineChart = LineChart;
})();
