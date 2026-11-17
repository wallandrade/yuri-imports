import { IconLucide } from "@/components/ui/IconLucide";
import {
  ADMIN_NAV,
  isNavItemActive,
  type AdminNavGroup,
  type AdminNavItem,
  type TabType,
} from "@/pages/admin/adminNav";

type VisibleGroup = AdminNavGroup & { items: AdminNavItem[] };

function visibleGroups(isPrimary: boolean): VisibleGroup[] {
  return ADMIN_NAV.map((group) => ({
    ...group,
    items: group.items.filter((item) => !item.hidden && (isPrimary || !item.primaryOnly)),
  })).filter((group) => group.items.length > 0);
}

/** Menu do admin: linha de grupos e, embaixo, as telas do grupo aberto. Em Início e Pedidos fica abaixo dos cards. Os grupos vêm de adminNav.ts. */
export function AdminGroupedNav({
  active,
  isPrimary,
  counts,
  onSelect,
}: {
  active: TabType;
  isPrimary: boolean;
  counts?: Partial<Record<TabType, number>>;
  onSelect: (tab: TabType) => void;
}) {
  const groups = visibleGroups(isPrimary);
  const currentGroup =
    groups.find((group) => group.items.some((item) => isNavItemActive(item, active))) ?? groups[0];

  return (
    <nav aria-label="Menu do admin" className="mb-6 rounded-xl border border-border bg-white">
      <ul className="flex gap-1 overflow-x-auto px-2 pt-2 pb-1 [scrollbar-width:none]">
        {groups.map((group) => {
          const isActive = group.key === currentGroup?.key;
          return (
            <li key={group.key} className="shrink-0">
              <button
                type="button"
                onClick={() => !isActive && onSelect(group.items[0].tab)}
                aria-current={isActive ? "true" : undefined}
                className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm whitespace-nowrap transition-colors ${isActive ? "bg-primary text-primary-foreground font-semibold" : "text-foreground/75 hover:bg-muted hover:text-foreground"}`}
              >
                <IconLucide name={group.icon} className="w-4 h-4" />
                {group.label}
              </button>
            </li>
          );
        })}
      </ul>
      {currentGroup && currentGroup.items.length > 1 && (
        <ul className="flex gap-1 overflow-x-auto border-t border-border px-2 py-1.5 [scrollbar-width:none]">
          {currentGroup.items.map((item) => {
            const isActive = isNavItemActive(item, active);
            const count = counts?.[item.tab];
            return (
              <li key={item.tab} className="shrink-0">
                <button
                  type="button"
                  onClick={() => onSelect(item.tab)}
                  aria-current={isActive ? "page" : undefined}
                  className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[13px] whitespace-nowrap transition-colors ${isActive ? "bg-primary/10 text-primary font-semibold" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`}
                >
                  <IconLucide name={item.icon} className="w-3.5 h-3.5" />
                  {item.label}
                  {typeof count === "number" && count > 0 && (
                    <span className={`text-[11px] px-1.5 rounded-full ${isActive ? "bg-primary/15" : "bg-muted"}`}>{count > 99 ? "99+" : count}</span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </nav>
  );
}
