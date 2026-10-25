import { t } from "../../lib/reactive/i18n.ts";
import { LoadingSkeleton } from "./loading-skeleton.tsx";

export function LoadingState(props: { route?: boolean } = {}) {
  return (
    <section
      class={[
        "lazy-view-state lazy-view-state--loading",
        { "lazy-view-state--route": props.route },
      ]}
      role="status"
      aria-live="polite"
      aria-label={t("common.loading")}
    >
      <LoadingSkeleton />
    </section>
  );
}
