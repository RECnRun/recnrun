import type { OpenTab } from "@/tabs/open-tabs";

/** A tab's icon, title, and address, with an Incognito badge and any other `badges`. */
export function TabSummary({ tab, badges = [] }: { tab: OpenTab; badges?: string[] }) {
  return (
    <>
      <span class="tab-title">
        {tab.favicon && (
          <img class="tab-favicon" src={tab.favicon} alt="" referrerpolicy="no-referrer" />
        )}
        <span>{tab.title}</span>
        {[...(tab.incognito ? ["Incognito"] : []), ...badges].map((badge) => (
          <span key={badge} class="tab-badge">
            {badge}
          </span>
        ))}
      </span>
      <span class="tab-url" title={tab.url}>
        {tab.url}
      </span>
    </>
  );
}
