/**
 * annotate.js
 *
 * Lightweight canvas annotation: lets the operator draw circles, arrows, or
 * freehand strokes over an uploaded image to mark non-spelling defects.
 *
 * Strokes are kept in an in-memory list so we can repaint cleanly on Undo /
 * Clear and so the final exported PNG always reflects the current state.
 *
 * Public API:
 *   const a = new Annotator(canvasEl);
 *   a.loadImage(fileOrUrl)         -> Promise<void>
 *   a.setTool('circle'|'arrow'|'freehand')
 *   a.setColor('#rrggbb')
 *   a.setWidth(int)
 *   a.undo()
 *   a.clear()
 *   a.toBlob()                     -> Promise<Blob>  (image/png)
 *   a.toDataURL()                  -> string         (image/png)
 */

(function (global) {
  class Annotator {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext("2d");
      this.image = null;
      this.shapes = [];          // committed strokes
      this.current = null;       // in-progress stroke
      this.tool = "circle";
      this.color = "#e63946";
      this.width = 4;
      this._bindEvents();
    }

    _bindEvents() {
      this.canvas.addEventListener("mousedown", e => this._start(e));
      this.canvas.addEventListener("mousemove", e => this._move(e));
      this.canvas.addEventListener("mouseup",   e => this._end(e));
      this.canvas.addEventListener("mouseleave",e => this._end(e));

      // Touch support for tablets on the shop floor
      this.canvas.addEventListener("touchstart", e => { e.preventDefault(); this._start(this._touch(e)); }, { passive: false });
      this.canvas.addEventListener("touchmove",  e => { e.preventDefault(); this._move(this._touch(e));  }, { passive: false });
      this.canvas.addEventListener("touchend",   e => { e.preventDefault(); this._end(this._touch(e));   }, { passive: false });
    }

    _touch(e) {
      const t = (e.touches && e.touches[0]) || (e.changedTouches && e.changedTouches[0]);
      if (!t) return { offsetX: 0, offsetY: 0 };
      const r = this.canvas.getBoundingClientRect();
      const scaleX = this.canvas.width  / r.width;
      const scaleY = this.canvas.height / r.height;
      return { offsetX: (t.clientX - r.left) * scaleX, offsetY: (t.clientY - r.top) * scaleY };
    }

    _pos(e) {
      // Mouse events on a CSS-scaled canvas need scaling too
      if (e.offsetX !== undefined && e.target === this.canvas) {
        const r = this.canvas.getBoundingClientRect();
        const scaleX = this.canvas.width  / r.width;
        const scaleY = this.canvas.height / r.height;
        return { x: e.offsetX * scaleX, y: e.offsetY * scaleY };
      }
      return { x: e.offsetX || 0, y: e.offsetY || 0 };
    }

    _start(e) {
      if (!this.image) return;
      const p = this._pos(e);
      this.current = {
        tool: this.tool,
        color: this.color,
        width: this.width,
        startX: p.x, startY: p.y,
        endX: p.x,   endY: p.y,
        points: this.tool === "freehand" ? [{ x: p.x, y: p.y }] : null
      };
    }

    _move(e) {
      if (!this.current) return;
      const p = this._pos(e);
      this.current.endX = p.x;
      this.current.endY = p.y;
      if (this.current.tool === "freehand") this.current.points.push({ x: p.x, y: p.y });
      this._redraw();
      this._drawShape(this.current);
    }

    _end() {
      if (!this.current) return;
      // Discard zero-length clicks except freehand which is intrinsically valid
      const dx = this.current.endX - this.current.startX;
      const dy = this.current.endY - this.current.startY;
      const valid = this.current.tool === "freehand"
        ? this.current.points.length > 1
        : (dx * dx + dy * dy) > 4;
      if (valid) this.shapes.push(this.current);
      this.current = null;
      this._redraw();
    }

    setTool(t)  { this.tool  = t; }
    setColor(c) { this.color = c; }
    setWidth(w) { this.width = parseInt(w, 10) || 4; }

    undo() {
      this.shapes.pop();
      this._redraw();
    }

    clear() {
      this.shapes = [];
      this._redraw();
    }

    async loadImage(source) {
      const url = source instanceof Blob ? URL.createObjectURL(source) : source;
      const img = await loadImage(url);
      // Cap the canvas at a sensible size so big phone photos don't break layout
      const MAX_W = 1200;
      const scale = img.width > MAX_W ? MAX_W / img.width : 1;
      this.canvas.width  = Math.round(img.width  * scale);
      this.canvas.height = Math.round(img.height * scale);
      this.image = img;
      this.shapes = [];
      this._redraw();
      if (source instanceof Blob) URL.revokeObjectURL(url);
    }

    _redraw() {
      const { ctx, canvas, image } = this;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (image) ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      for (const s of this.shapes) this._drawShape(s);
    }

    _drawShape(s) {
      const ctx = this.ctx;
      ctx.save();
      ctx.strokeStyle = s.color;
      ctx.lineWidth   = s.width;
      ctx.lineCap     = "round";
      ctx.lineJoin    = "round";

      if (s.tool === "circle") {
        const cx = (s.startX + s.endX) / 2;
        const cy = (s.startY + s.endY) / 2;
        const rx = Math.abs(s.endX - s.startX) / 2;
        const ry = Math.abs(s.endY - s.startY) / 2;
        ctx.beginPath();
        ctx.ellipse(cx, cy, Math.max(rx, 1), Math.max(ry, 1), 0, 0, Math.PI * 2);
        ctx.stroke();
      } else if (s.tool === "arrow") {
        drawArrow(ctx, s.startX, s.startY, s.endX, s.endY, s.width);
      } else if (s.tool === "freehand" && s.points) {
        ctx.beginPath();
        ctx.moveTo(s.points[0].x, s.points[0].y);
        for (let i = 1; i < s.points.length; i++) ctx.lineTo(s.points[i].x, s.points[i].y);
        ctx.stroke();
      }
      ctx.restore();
    }

    toDataURL() { return this.canvas.toDataURL("image/png"); }

    toBlob() {
      return new Promise(resolve => this.canvas.toBlob(b => resolve(b), "image/png"));
    }
  }

  function drawArrow(ctx, x1, y1, x2, y2, lineWidth) {
    const headLen = Math.max(12, lineWidth * 3);
    const angle = Math.atan2(y2 - y1, x2 - x1);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - headLen * Math.cos(angle - Math.PI / 6), y2 - headLen * Math.sin(angle - Math.PI / 6));
    ctx.lineTo(x2 - headLen * Math.cos(angle + Math.PI / 6), y2 - headLen * Math.sin(angle + Math.PI / 6));
    ctx.closePath();
    ctx.fillStyle = ctx.strokeStyle;
    ctx.fill();
  }

  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = url;
    });
  }

  global.Annotator = Annotator;
})(window);
