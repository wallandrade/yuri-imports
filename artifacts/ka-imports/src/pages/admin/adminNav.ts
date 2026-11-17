/** Mapa do menu do admin. A sidebar e as rotas /admin/<grupo>/<item> leem só daqui. */

export type TabType =
  | "inicio"
  | "orders"
  | "charges"
  | "commissions"
  | "expenses"
  | "dre"
  | "sellers"
  | "coupons"
  | "flashCampaigns"
  | "products"
  | "fretes"
  | "orderBumps"
  | "kyc"
  | "users"
  | "customers"
  | "recurringCustomers"
  | "support"
  | "biblioteca"
  | "inventory"
  | "rastreios"
  | "listaNegra"
  | "extrato"
  | "depositos"
  | "conciliacao"
  | "webhook"
  | "configuracoes"
  | "atendimento"
  | "automacao"
  | "imagens"
  | "identidade"
  | "socialProof"
  | "raffles"
  | "checkout"
  | "seguro"
  | "cellTech"
  | "fornecedores"
  | "avisos"
  | "poly"
  | "taxas"
  | "pagamentos"
  | "pushcut"
  | "email"
  | "diagnostico";

export type AdminNavItem = {
  tab: TabType;
  slug: string;
  label: string;
  icon: string;
  primaryOnly: boolean;
  /** Some da sidebar, mas a URL continua abrindo a tela. */
  hidden?: boolean;
  /** Abas que também acendem este item (atalhos da mesma tela). */
  activeTabs?: TabType[];
};

export type AdminNavGroup = {
  key: string;
  slug: string;
  label: string;
  icon: string;
  items: AdminNavItem[];
};

export const ADMIN_NAV: AdminNavGroup[] = [
  {
    key: "inicio",
    slug: "inicio",
    label: "Início",
    icon: "LayoutDashboard",
    items: [
      { tab: "inicio", slug: "painel", label: "Início", icon: "LayoutDashboard", primaryOnly: false },
    ],
  },
  {
    key: "vendas",
    slug: "vendas",
    label: "Vendas",
    icon: "ShoppingCart",
    items: [
      { tab: "orders", slug: "pedidos", label: "Pedidos", icon: "ClipboardList", primaryOnly: false },
      { tab: "checkout", slug: "checkout", label: "Checkout", icon: "CreditCard", primaryOnly: true },
      { tab: "seguro", slug: "seguro", label: "Seguro", icon: "ShieldCheck", primaryOnly: true },
    ],
  },
  {
    key: "catalogo",
    slug: "catalogo",
    label: "Catálogo e estoque",
    icon: "Package",
    items: [
      { tab: "products", slug: "produtos", label: "Produtos", icon: "ShoppingBag", primaryOnly: true },
      { tab: "inventory", slug: "estoque", label: "Estoque", icon: "Boxes", primaryOnly: true },
      { tab: "fornecedores", slug: "fornecedores", label: "Fornecedores", icon: "Store", primaryOnly: false },
      {
        tab: "identidade",
        slug: "identidade",
        label: "Identidade e imagens",
        icon: "Image",
        primaryOnly: true,
        activeTabs: ["imagens"],
      },
      { tab: "imagens", slug: "imagens", label: "Imagens", icon: "Image", primaryOnly: true, hidden: true },
    ],
  },
  {
    key: "envios",
    slug: "envios",
    label: "Envios",
    icon: "Truck",
    items: [
      { tab: "fretes", slug: "fretes", label: "Fretes", icon: "Calculator", primaryOnly: true },
      { tab: "rastreios", slug: "rastreios", label: "Rastreios", icon: "MapPin", primaryOnly: false },
      { tab: "listaNegra", slug: "lista-negra", label: "Lista negra", icon: "ShieldAlert", primaryOnly: true },
    ],
  },
  {
    key: "clientes",
    slug: "clientes",
    label: "Clientes",
    icon: "Users",
    items: [
      { tab: "customers", slug: "clientes", label: "Clientes", icon: "UserPlus", primaryOnly: false },
      { tab: "recurringCustomers", slug: "recorrentes", label: "Recorrentes", icon: "RefreshCw", primaryOnly: false },
      { tab: "kyc", slug: "kyc", label: "KYC", icon: "BadgeCheck", primaryOnly: false },
      { tab: "support", slug: "tickets", label: "Tickets do site", icon: "LifeBuoy", primaryOnly: false },
    ],
  },
  {
    key: "marketing",
    slug: "marketing",
    label: "Marketing",
    icon: "Megaphone",
    items: [
      { tab: "coupons", slug: "cupons", label: "Cupons", icon: "Ticket", primaryOnly: true },
      { tab: "flashCampaigns", slug: "promocoes", label: "Promoções", icon: "Zap", primaryOnly: true },
      { tab: "orderBumps", slug: "order-bumps", label: "Order bumps", icon: "PlusCircle", primaryOnly: true },
      { tab: "socialProof", slug: "prova-social", label: "Prova social", icon: "Star", primaryOnly: true },
      { tab: "raffles", slug: "rifas", label: "Rifas", icon: "Gift", primaryOnly: true },
    ],
  },
  {
    key: "whatsapp",
    slug: "whatsapp",
    label: "WhatsApp",
    icon: "MessageCircle",
    items: [
      { tab: "atendimento", slug: "atendimento", label: "Atendimento", icon: "MessagesSquare", primaryOnly: true },
      { tab: "avisos", slug: "avisos", label: "Avisos de pedido", icon: "BellRing", primaryOnly: true },
      { tab: "poly", slug: "poly", label: "Poly", icon: "Phone", primaryOnly: true },
      { tab: "automacao", slug: "grupos", label: "Grupos", icon: "Send", primaryOnly: true },
    ],
  },
  {
    key: "assistencia",
    slug: "assistencia",
    label: "Assistência (Cell Tech)",
    icon: "Wrench",
    items: [
      { tab: "cellTech", slug: "cell-tech", label: "Cell Tech", icon: "Smartphone", primaryOnly: true },
    ],
  },
  {
    key: "financeiro",
    slug: "financeiro",
    label: "Financeiro",
    icon: "Wallet",
    items: [
      {
        tab: "conciliacao",
        slug: "conciliacao",
        label: "Conciliação",
        icon: "Landmark",
        primaryOnly: true,
        activeTabs: ["extrato", "depositos"],
      },
      { tab: "extrato", slug: "extrato", label: "Extrato", icon: "Landmark", primaryOnly: true, hidden: true },
      { tab: "depositos", slug: "depositos", label: "Depósitos", icon: "Wallet", primaryOnly: true, hidden: true },
      { tab: "webhook", slug: "webhook", label: "Webhook do PIX", icon: "Link", primaryOnly: true },
      { tab: "charges", slug: "links", label: "Links de pagamento", icon: "Link2", primaryOnly: false },
      { tab: "taxas", slug: "taxas", label: "Taxas do gateway", icon: "Percent", primaryOnly: true },
      { tab: "pagamentos", slug: "pagamentos", label: "Pagamentos por canal", icon: "Banknote", primaryOnly: true },
      { tab: "expenses", slug: "despesas", label: "Despesas", icon: "Receipt", primaryOnly: true },
      { tab: "commissions", slug: "comissoes", label: "Comissões", icon: "DollarSign", primaryOnly: false },
      { tab: "sellers", slug: "vendedores", label: "Vendedores", icon: "Tag", primaryOnly: false },
      { tab: "dre", slug: "dre", label: "DRE", icon: "PieChart", primaryOnly: true },
    ],
  },
  {
    key: "sistema",
    slug: "sistema",
    label: "Sistema",
    icon: "Settings",
    items: [
      { tab: "users", slug: "usuarios", label: "Usuários e acesso", icon: "User", primaryOnly: true },
      { tab: "pushcut", slug: "pushcut", label: "Pushcut", icon: "Bell", primaryOnly: true },
      { tab: "email", slug: "email", label: "E-mail (Brevo)", icon: "Mail", primaryOnly: true },
      { tab: "diagnostico", slug: "diagnostico", label: "Diagnóstico de erros", icon: "Bug", primaryOnly: true },
      { tab: "biblioteca", slug: "biblioteca", label: "Biblioteca", icon: "BookOpen", primaryOnly: false },
      { tab: "configuracoes", slug: "configuracao", label: "Configuração", icon: "Settings", primaryOnly: true },
    ],
  },
];

export const PRIMARY_ONLY_TABS: ReadonlySet<TabType> = new Set(
  ADMIN_NAV.flatMap((group) => group.items.filter((item) => item.primaryOnly).map((item) => item.tab)),
);

export function adminNavItemPath(group: AdminNavGroup, item: AdminNavItem): string {
  return `/admin/${group.slug}/${item.slug}`;
}

const PATH_BY_TAB = new Map<TabType, string>();
for (const group of ADMIN_NAV) {
  for (const item of group.items) {
    if (item.hidden) continue;
    if (!PATH_BY_TAB.has(item.tab)) PATH_BY_TAB.set(item.tab, adminNavItemPath(group, item));
  }
}
for (const group of ADMIN_NAV) {
  for (const item of group.items) {
    if (!PATH_BY_TAB.has(item.tab)) PATH_BY_TAB.set(item.tab, adminNavItemPath(group, item));
  }
}

export function pathForTab(tab: TabType): string {
  return PATH_BY_TAB.get(tab) ?? "/admin/vendas/pedidos";
}

export function isNavItemActive(item: AdminNavItem, tab: TabType): boolean {
  return item.tab === tab || (item.activeTabs?.includes(tab) ?? false);
}

export function navItemByTab(tab: TabType): { group: AdminNavGroup; item: AdminNavItem } | null {
  for (const group of ADMIN_NAV) {
    const item = group.items.find((entry) => entry.tab === tab && !entry.hidden);
    if (item) return { group, item };
  }
  for (const group of ADMIN_NAV) {
    const item = group.items.find((entry) => entry.tab === tab);
    if (item) return { group, item };
  }
  return null;
}

function normalizeAdminPath(raw: string): string {
  const path = raw.split("?")[0].split("#")[0].replace(/\/+$/, "");
  return path || "/admin";
}

/** Lê a URL e diz qual aba abrir. `redirect` troca a barra de endereço (F5 fica na tela). */
export function resolveAdminPath(raw: string): { tab: TabType; redirect: string | null } {
  const path = normalizeAdminPath(raw);
  if (path === "/admin") return { tab: "orders", redirect: "/admin/vendas/pedidos" };
  if (path === "/admin/fornecedores") return { tab: "fornecedores", redirect: "/admin/catalogo/fornecedores" };

  const rest = path.startsWith("/admin/") ? path.slice("/admin/".length) : "";
  const parts = rest.split("/").filter(Boolean);
  if (parts.length === 1) {
    const group = ADMIN_NAV.find((entry) => entry.slug === parts[0]);
    const item = group?.items.find((entry) => !entry.hidden) ?? group?.items[0];
    if (group && item) return { tab: item.tab, redirect: adminNavItemPath(group, item) };
  }
  if (parts.length === 2) {
    const group = ADMIN_NAV.find((entry) => entry.slug === parts[0]);
    const item = group?.items.find((entry) => entry.slug === parts[1]);
    if (group && item) return { tab: item.tab, redirect: null };
  }
  return { tab: "orders", redirect: "/admin/vendas/pedidos" };
}
