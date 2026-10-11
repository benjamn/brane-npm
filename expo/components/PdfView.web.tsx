import React, { useEffect, useRef, useState } from "react";

// Why not just <iframe src=pdf>? On iOS Safari the browser's built-in PDF
// viewer renders page one only, with no scroll or zoom. Painting each page to
// a canvas ourselves gives consistent multi-page scroll + pinch-zoom everywhere.
//
// Why load pdf.js this way? The app is built with web.output:"single", whose
// metro pipeline won't code-split — a normal `import("pdfjs-dist")` would fold
// pdf.js (~450KB) into the one main bundle. Instead we ship the standalone ESM
// build to public/ and import it at *runtime* from a same-origin URL, hidden
// from metro's static analysis via new Function(). So pdf.js is in no bundle at
// all — the browser fetches it (and its worker) only when a PDF is opened.
// Those two files are pdf.js's *legacy* build, vendored by `npm run sync:pdfjs`;
// the modern build calls newer builtins than browsers ship, and renders blank.
// (There is no CSP on the daemon, so the eval-style import is unblocked.)

const importExternal: (url: string) => Promise<any> =
  // eslint-disable-next-line no-new-func
  new Function("u", "return import(u)") as any;

let pdfjsPromise: Promise<any> | null = null;
function loadPdfjs(): Promise<any> {
  if (!pdfjsPromise) {
    pdfjsPromise = importExternal("/pdf.min.mjs").then((pdfjs) => {
      pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
      return pdfjs;
    });
  }
  return pdfjsPromise;
}

// Module-level caches so the viewer survives remounts/reloads without losing
// the reader's place or re-downloading: fetched bytes, and per-url view state
// (zoom + scroll offset).
const bytesCache = new Map<string, Uint8Array>();
const viewState = new Map<string, { zoom: number; left: number; top: number }>();

// Zoom is applied by CSS-resizing the page canvases — NOT by re-rasterizing.
// Re-rendering 34 pages at a higher zoom spikes memory, and iOS WebKit reloads
// the tab under memory pressure. Each canvas is rasterized once at fit-width ×
// device-pixel-ratio (constant memory); zoom just scales its CSS box, so the
// browser upscales the existing bitmap (crisp within the pixel-ratio headroom)
// and native scroll keeps panning.
function applyZoom(stage: HTMLDivElement, zoom: number) {
  for (const el of Array.from(stage.children)) {
    const c = el as HTMLElement;
    const bw = Number(c.dataset.baseW);
    const bh = Number(c.dataset.baseH);
    if (bw && bh) {
      c.style.width = `${Math.round(bw * zoom)}px`;
      c.style.height = `${Math.round(bh * zoom)}px`;
    }
  }
}

type Status = "loading" | "ready" | "error";

const MIN_Z = 1; // fit-to-width
const MAX_Z = 6;

export function PdfView({ url }: { url: string }) {
  const scrollRef = useRef<HTMLDivElement | null>(null); // scroll surface (pan)
  const stageRef = useRef<HTMLDivElement | null>(null); // holds the page canvases
  const docRef = useRef<any>(null);
  const renderIdRef = useRef(0);
  const [zoom, setZoom] = useState(() => viewState.get(url)?.zoom ?? 1);
  const zoomRef = useRef(zoom); // committed zoom, mirrored for touch handlers
  const [status, setStatus] = useState<Status>("loading");
  const [error, setError] = useState("");

  // Mirror zoom + persist it (with current scroll) so a remount restores it.
  useEffect(() => {
    zoomRef.current = zoom;
    const s = scrollRef.current;
    if (s) viewState.set(url, { zoom, left: s.scrollLeft, top: s.scrollTop });
  }, [zoom, url]);

  // Load the document once per url (bytes cached to avoid re-downloading).
  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    setError("");
    (async () => {
      try {
        const pdfjs: any = await loadPdfjs();
        let bytes = bytesCache.get(url);
        if (!bytes) {
          const res = await fetch(url);
          if (!res.ok) throw new Error(`fetch ${res.status}`);
          bytes = new Uint8Array(await res.arrayBuffer());
          bytesCache.set(url, bytes);
        }
        if (cancelled) return;
        // pdf.js may detach the buffer it's handed — give it a copy so the
        // cached bytes stay reusable for the next mount.
        const doc = await pdfjs.getDocument({ data: bytes.slice() }).promise;
        if (cancelled) {
          doc.destroy?.();
          return;
        }
        docRef.current = doc;
        setStatus("ready");
      } catch (e: any) {
        if (!cancelled) {
          setError(String(e?.message ?? e));
          setStatus("error");
        }
      }
    })();
    return () => {
      cancelled = true;
      const d = docRef.current;
      docRef.current = null;
      d?.destroy?.();
    };
  }, [url]);

  // Render every page ONCE at fit-width × dpr. Zoom is applied via CSS afterward
  // (applyZoom), so this effect does NOT depend on zoom — no re-raster on pinch.
  useEffect(() => {
    const doc = docRef.current;
    const stage = stageRef.current;
    const scroll = scrollRef.current;
    if (status !== "ready" || !doc || !stage || !scroll) return;
    const myId = ++renderIdRef.current;
    const tasks: any[] = [];
    (async () => {
      const dpr = window.devicePixelRatio || 1;
      const cssW = Math.max(120, scroll.clientWidth || 800);
      const pages = await Promise.all(
        Array.from({ length: doc.numPages }, (_, i) => doc.getPage(i + 1)),
      );
      if (renderIdRef.current !== myId) return;

      // Pass 1 — create + size every canvas (backing = fit×dpr, CSS = fit) so
      // layout/scroll extent is final, then apply the current zoom via CSS.
      stage.innerHTML = "";
      const jobs: { page: any; canvas: HTMLCanvasElement; viewport: any }[] = [];
      for (const page of pages) {
        const unit = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: (cssW / unit.width) * dpr });
        const baseW = viewport.width / dpr;
        const baseH = viewport.height / dpr;
        const canvas = document.createElement("canvas");
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        canvas.dataset.baseW = String(baseW);
        canvas.dataset.baseH = String(baseH);
        canvas.style.width = `${Math.round(baseW)}px`;
        canvas.style.height = `${Math.round(baseH)}px`;
        canvas.style.display = "block";
        canvas.style.margin = "0 auto 6px";
        canvas.style.background = "#fff";
        canvas.style.boxShadow = "0 1px 4px rgba(0,0,0,0.4)";
        stage.appendChild(canvas);
        jobs.push({ page, canvas, viewport });
      }
      applyZoom(stage, zoomRef.current);

      // Restore the persisted scroll offset for this url (hold position across
      // re-renders / remounts).
      const saved = viewState.get(url);
      if (saved) {
        scroll.scrollLeft = saved.left;
        scroll.scrollTop = saved.top;
      }

      // Pass 2 — paint (viewport already carries the dpr scale).
      for (const { page, canvas, viewport } of jobs) {
        if (renderIdRef.current !== myId) return;
        const ctx = canvas.getContext("2d");
        if (!ctx) continue;
        const task = page.render({ canvas, canvasContext: ctx, viewport });
        tasks.push(task);
        try {
          await task.promise;
        } catch {
          /* superseded — ignore */
        }
      }
    })();
    return () => {
      for (const t of tasks) t.cancel?.();
    };
  }, [status, url]);

  // Pinch-to-zoom, scoped to the frame. Non-passive touch listeners let us
  // stopPropagation the app's tab swipe; the browser's native pinch (WebKit
  // gesture* events) is suppressed document-wide by FilesView while a file is
  // open. Live CSS transform during the gesture, then commit by CSS-resizing the
  // canvases (no re-raster) and restoring scroll so the focal point stays put.
  useEffect(() => {
    const scroll = scrollRef.current;
    const stage = stageRef.current;
    if (!scroll || !stage || status !== "ready") return;

    let pinch:
      | null
      | {
          startDist: number;
          startZoom: number;
          startScrollLeft: number;
          startScrollTop: number;
          screenX: number;
          screenY: number;
          target: number;
        } = null;

    const distance = (t: TouchList) =>
      Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    const midpoint = (t: TouchList) => ({
      x: (t[0].clientX + t[1].clientX) / 2,
      y: (t[0].clientY + t[1].clientY) / 2,
    });

    const onTouchStart = (e: TouchEvent) => {
      e.stopPropagation();
      if (e.touches.length !== 2) return;
      e.preventDefault();
      const m = midpoint(e.touches);
      const r = scroll.getBoundingClientRect();
      pinch = {
        startDist: distance(e.touches),
        startZoom: zoomRef.current,
        startScrollLeft: scroll.scrollLeft,
        startScrollTop: scroll.scrollTop,
        screenX: m.x - r.left,
        screenY: m.y - r.top,
        target: zoomRef.current,
      };
    };

    const onTouchMove = (e: TouchEvent) => {
      e.stopPropagation();
      if (!pinch || e.touches.length !== 2) return;
      e.preventDefault();
      const ratio = distance(e.touches) / pinch.startDist;
      pinch.target = Math.min(MAX_Z, Math.max(MIN_Z, pinch.startZoom * ratio));
      const live = pinch.target / pinch.startZoom;
      const fx = pinch.startScrollLeft + pinch.screenX;
      const fy = pinch.startScrollTop + pinch.screenY;
      stage.style.transformOrigin = "0 0";
      stage.style.transform = `translate(${-fx * (live - 1)}px, ${-fy * (live - 1)}px) scale(${live})`;
    };

    const onTouchEnd = (e: TouchEvent) => {
      e.stopPropagation();
      if (!pinch) return;
      const committed = pinch.target;
      const k = committed / pinch.startZoom;
      const fx = pinch.startScrollLeft + pinch.screenX;
      const fy = pinch.startScrollTop + pinch.screenY;
      stage.style.transform = "";
      stage.style.transformOrigin = "";
      // CSS-resize (no re-raster), then put the focal point back under the fingers.
      applyZoom(stage, committed);
      scroll.scrollLeft = Math.max(0, fx * k - pinch.screenX);
      scroll.scrollTop = Math.max(0, fy * k - pinch.screenY);
      pinch = null;
      if (Math.abs(committed - zoomRef.current) > 0.001) setZoom(committed);
    };

    const onScroll = () => {
      viewState.set(url, { zoom: zoomRef.current, left: scroll.scrollLeft, top: scroll.scrollTop });
    };

    scroll.addEventListener("touchstart", onTouchStart, { passive: false });
    scroll.addEventListener("touchmove", onTouchMove, { passive: false });
    scroll.addEventListener("touchend", onTouchEnd, { passive: false });
    scroll.addEventListener("touchcancel", onTouchEnd, { passive: false });
    scroll.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      scroll.removeEventListener("touchstart", onTouchStart);
      scroll.removeEventListener("touchmove", onTouchMove);
      scroll.removeEventListener("touchend", onTouchEnd);
      scroll.removeEventListener("touchcancel", onTouchEnd);
      scroll.removeEventListener("scroll", onScroll);
    };
  }, [status, url]);

  if (status === "error") {
    return <div style={ERR}>Failed to render PDF: {error}</div>;
  }
  return (
    <div ref={scrollRef} style={SCROLL}>
      <div ref={stageRef} style={STAGE} />
    </div>
  );
}

const SCROLL: React.CSSProperties = {
  height: "100%",
  width: "100%",
  overflow: "auto",
  background: "#2b2b2b",
  touchAction: "pan-x pan-y",
  WebkitOverflowScrolling: "touch",
};
const STAGE: React.CSSProperties = { transformOrigin: "0 0" };
const ERR: React.CSSProperties = { color: "#f88", padding: 12, fontFamily: "monospace", fontSize: 13 };

export default PdfView;
