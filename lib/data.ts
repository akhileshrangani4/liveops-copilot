import catalogJson from "@/data/catalog.json";
import scriptJson from "@/data/chat-script.json";

export type Listing = {
  sku: string;
  title: string;
  brand: string;
  size: string;
  condition: string;
  price_usd: number;
  msrp_usd: number;
  stock: number;
  tags: string[];
  description: string;
  active: boolean;
  featured: boolean;
};

export type SellerPolicies = {
  returns: string;
  shipping: string;
  auth: string;
  discount_floor_pct: number;
  max_markdown_pct: number;
};

export type Catalog = {
  seller: { id: string; name: string; rating: number; policies: SellerPolicies };
  listings: Listing[];
};

export const catalog = catalogJson as Catalog;
export const chatScript = scriptJson as {
  show: { id: string; title: string; host: string };
  messages: { delayMs: number; user: string; text: string }[];
};

export function findListing(sku: string): Listing | undefined {
  return catalog.listings.find((l) => l.sku === sku);
}

export function searchListings(query: string): Listing[] {
  const q = query.toLowerCase();
  return catalog.listings.filter(
    (l) =>
      l.title.toLowerCase().includes(q) ||
      l.tags.some((t) => t.includes(q)) ||
      l.brand.toLowerCase().includes(q) ||
      l.sku.toLowerCase().includes(q),
  );
}
