import { useEffect, useState } from "react";
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

function NavList({
  groups,
  active,
  counts,
  onSelect,
}: {
  groups: VisibleGroup[];
  active: TabType;
  counts?: Partial<Record<TabType, number>>;
  onSelect: (tab: TabType) => void;
}) {
  return (
    <nav aria-label="Menu do admin" className="space-y-4">
      {groups.map((group) => (
        <div key={group.key}>
          <p className="flex items-center gap-1.5 px-2 mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            <IconLucide name={group.icon} className="w-3.5 h-3.5" />
            {group.label}
          </p>
          <ul className="space-y-0.5">
            {group.items.map((item) => {
              const isActive = isNavItemActive(item, active);
              const count = counts?.[item.tab];
              return (
                <li key={item.tab}>
                  <button
                    type="button"
                    onClick={() => onSelect(item.tab)}
                    aria-current={isActive ? "page" : undefined}
                    className={`w-full flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-left transition-colors ${isActive ? "bg-primary/10 text-primary font-semibold" : "text-foreground/80 hover:bg-muted hover:text-foreground"}`}
                  >
                    <IconLucide name={item.icon} className="w-4 h-4 shrink-0" />
                    <span className="flex-1 truncate">{item.label}</span>
                    {typeof count === "number" && count > 0 && (
                      <span className={`text-[11px] px-1.5 py-0.5 rounded-full ${isActive ? "bg-primary/15" : "bg-muted text-muted-foreground"}`}>{count > 99 ? "99+" : count}</span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

/** Menu lateral (desktop) e gaveta (celular). Os grupos vêm de adminNav.ts. */
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
  const [open, setOpen] = useState(false);
  const current = groups
    .flatMap((group) => group.items.map((item) => ({ item, group: group.label })))
    .find((entry) => isNavItemActive(entry.item, active));

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const select = (tab: TabType) => { onSelect(tab); setOpen(false); };

  return (
    <>
      <div className="lg:hidden mb-4">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="w-full flex items-center gap-3 rounded-xl border border-border bg-white px-3 py-2.5 text-left shadow-sm"
        >
          <IconLucide name="Menu" className="w-5 h-5 text-muted-foreground" />
          <span className="flex-1 min-w-0">
            <span className="block text-[11px] uppercase tracking-wider text-muted-foreground">{current?.group ?? "Menu"}</span>
            <span className="block text-sm font-semibold truncate">{current?.item.label ?? "Escolher área"}</span>
          </span>
          <IconLucide name="ChevronDown" className="w-4 h-4 text-muted-foreground" />
        </button>
      </div>
      {open && (
        <div className="lg:hidden fixed inset-0 z-[80]" role="dialog" aria-modal="true">
          <div className="absolute inset-0 bg-black/40" onClick={() => setOpen(false)} />
          <div className="absolute inset-y-0 left-0 w-[82vw] max-w-xs bg-white shadow-2xl overflow-y-auto p-4">
            <div className="flex items-center justify-between mb-4">
              <span className="font-bold">Menu do admin</span>
              <button type="button" aria-label="Fechar menu" onClick={() => setOpen(false)} className="p-1 rounded-md hover:bg-muted">
                <IconLucide name="X" className="w-5 h-5" />
              </button>
            </div>
            <NavList groups={groups} active={active} counts={counts} onSelect={select} />
          </div>
        </div>
      )}

      <aside className="hidden lg:block w-56 shrink-0">
        <div className="sticky top-4 max-h-[calc(100vh-2rem)] overflow-y-auto rounded-xl border border-border bg-white p-3">
          <NavList groups={groups} active={active} counts={counts} onSelect={onSelect} />
        </div>
      </aside>
    </>
  );
}
