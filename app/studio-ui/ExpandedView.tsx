import type { ReactNode } from "react";

/**
 * A step's expert view, in the one layout every step shares: a grouped list on the left, the character in the centre
 * with one small toolbar on top (view toggles top-right, zoom bottom-right), and the selected item alone on the right.
 * Rendered as StepShell's `expanded`, so the top bar and action bar stay where they always are.
 */
export function ExpandedView({ left, center, tools, viewToggles, zoom, right, bottom }: {
  readonly left: ReactNode; readonly center: ReactNode; readonly tools: ReactNode;
  readonly viewToggles?: ReactNode; readonly zoom?: ReactNode; readonly right: ReactNode;
  /** A strip across the bottom of the centre column only (the Animate timeline). */
  readonly bottom?: ReactNode;
}) {
  return <div className="expanded">
    <aside className="expanded-left">{left}</aside>
    <section className="expanded-center">
      <div className="expanded-stage">
        {center}
        <div className="expanded-tools" role="toolbar">{tools}</div>
        {viewToggles && <div className="expanded-view-toggles">{viewToggles}</div>}
        {zoom && <div className="expanded-zoom">{zoom}</div>}
      </div>
      {bottom && <div className="expanded-bottom">{bottom}</div>}
    </section>
    <aside className="expanded-right">{right}</aside>
  </div>;
}
