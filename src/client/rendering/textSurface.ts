import { layoutWithLines, prepareWithSegments, type PreparedTextWithSegments } from "@chenglou/pretext";

type TextSurfaceOptions = {
  font: string;
  lineHeight: number;
  className?: string;
};

type MountedTextSurface = {
  element: HTMLElement;
  text: string;
  options: TextSurfaceOptions;
  prepared: PreparedTextWithSegments | null;
  width: number;
};

const mounted = new Set<MountedTextSurface>();

const resizeObserver = new ResizeObserver((entries) => {
  for (const entry of entries) {
    const surface = findSurface(entry.target);
    if (surface === undefined) continue;
    renderSurface(surface);
  }
});

export function mountTextSurface(element: HTMLElement, text: string, options: TextSurfaceOptions): void {
  const surface: MountedTextSurface = {
    element,
    text,
    options,
    prepared: null,
    width: 0,
  };

  mounted.add(surface);
  element.classList.add("text-surface");
  if (options.className !== undefined) element.classList.add(options.className);
  resizeObserver.observe(element);
  renderSurface(surface);
}

export function unmountAllTextSurfaces(): void {
  for (const surface of mounted) {
    resizeObserver.unobserve(surface.element);
  }

  mounted.clear();
}

function findSurface(target: Element): MountedTextSurface | undefined {
  for (const surface of mounted) {
    if (surface.element === target) return surface;
  }

  return undefined;
}

function renderSurface(surface: MountedTextSurface): void {
  const width = Math.floor(surface.element.clientWidth);
  if (width <= 0) return;

  if (surface.prepared === null) {
    // TODO: deepen Pretext integration so stream rows can virtualize without DOM text measurement.
    surface.prepared = prepareWithSegments(surface.text, surface.options.font, { whiteSpace: "pre-wrap" });
  }

  if (surface.width === width && surface.element.childElementCount > 0) return;

  surface.width = width;
  const frame = layoutWithLines(surface.prepared, width, surface.options.lineHeight);
  const fragment = document.createDocumentFragment();

  for (const line of frame.lines) {
    const row = document.createElement("span");
    row.className = "text-surface__line";
    row.textContent = line.text.length === 0 ? " " : line.text;
    fragment.append(row);
  }

  surface.element.replaceChildren(fragment);
  surface.element.style.minHeight = `${frame.height}px`;
}
