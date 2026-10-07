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
      const { left, top, side } = placeTooltip(
        anchor,
        { width: el.offsetWidth, height: el.offsetHeight },
        { width: window.innerWidth, height: window.innerHeight },
      );
      el.style.left = `${left}px`;
      el.style.top = `${top}px`;
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
    <div ref={ref} {...rest} style={{ ...style, position: 'fixed', left: 0, top: 0 }}>
      {children}
    </div>,
    document.body,
  );
};

export default FloatingTooltip;
