/**
 * A hover panel anchored to a viewport point, which always displays whole
 * (#248).
 *
 * - **Portalled to `document.body`, `position: fixed`.** The graph containers
 *   are `overflow: hidden`, so a panel rendered inside one is clipped at the
 *   container edge however much room the window has.
 * - **Placed from its measured size** by `placeTooltip`, in viewport
 *   coordinates only.
 * - **Re-placed when it changes size** (sequence data arrives after the panel
 *   opens, and live steps re-render it) and when the window resizes, so a
 *   pinned panel stays on screen too.
 * - **Pinned by the edge nearest the pointer.** A panel left of the pointer is
 *   positioned by its `right` edge, one above it by its `bottom` edge, so when
 *   it grows it grows *away* from the pointer. Positioned by `left`/`top` only,
 *   a left-side panel that grew (the "Loading sequences…" panel becoming the
 *   full CES graph) spanned the pointer for a frame before the re-placement
 *   moved it: the browser saw the pointer enter the panel and then leave it,
 *   and the panel's own hover-out closed it 220 ms after it opened.
 *
 * Callers pass the raw pointer position (`event.clientX/clientY`) as the
 * anchor, with no offsets: keeping the panel clear of the pointer is the
 * placement's job.
 */

import React, { useLayoutEffect, useRef } from 'react';
import ReactDOM from 'react-dom';
import { placeTooltip } from '../utils/tooltipPlacement';
import type { Point } from '../utils/tooltipPlacement';

export interface FloatingTooltipProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, 'style'> {
  /** The pointer, in viewport coordinates. */
  anchor: Point;
  /** Styles for the panel; `position`, `left` and `top` are owned here. */
  style?: React.CSSProperties;
  children: React.ReactNode;
}

export const FloatingTooltip: React.FC<FloatingTooltipProps> = ({
  anchor, style, children, ...rest
}) => {
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    const place = () => {
      // offsetWidth/Height: the layout size, unaffected by an entry transform.
      const width = el.offsetWidth;
      const height = el.offsetHeight;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const { left, top, side } = placeTooltip(anchor, { width, height }, { width: vw, height: vh });
      // Hold the edge facing the pointer, so growth extends away from it.
      if (side === 'left') {
        el.style.left = 'auto';
        el.style.right = `${vw - (left + width)}px`;
      } else {
        el.style.right = 'auto';
        el.style.left = `${left}px`;
      }
      if (side === 'above') {
        el.style.top = 'auto';
        el.style.bottom = `${vh - (top + height)}px`;
      } else {
        el.style.bottom = 'auto';
        el.style.top = `${top}px`;
      }
      el.dataset.side = side;
    };

    place();
    window.addEventListener('resize', place);
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(place) : null;
    observer?.observe(el);
    return () => {
      window.removeEventListener('resize', place);
      observer?.disconnect();
    };
  }, [anchor.x, anchor.y]);

  return ReactDOM.createPortal(
    <div ref={ref} {...rest} style={{ ...style, position: 'fixed' }}>
      {children}
    </div>,
    document.body,
  );
};

export default FloatingTooltip;
