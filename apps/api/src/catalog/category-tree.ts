import type { TreeType } from '@prisma/client';

export interface CategoryRow {
  id: string;
  parent_id: string | null;
  tree_type: TreeType;
  slug: string;
  name_ru: string;
  name_uz: string;
  sort_order: number;
}

export interface CategoryNode {
  id: string;
  slug: string;
  name_ru: string;
  name_uz: string;
  /** Distinct customer-visible products in this category and all its subcategories. */
  product_count: number;
  children: CategoryNode[];
}

export type CategoryTrees = Record<TreeType, CategoryNode[]>;

/**
 * Builds both trees ("need" and "product_type") from active category rows.
 * A child whose parent is missing (e.g. parent archived) is hidden together with its subtree.
 */
export function buildCategoryTrees(rows: CategoryRow[], productsByCategory: Map<string, Set<string>> = new Map()): CategoryTrees {
  const sorted = [...rows].sort((a, b) => a.sort_order - b.sort_order || a.name_ru.localeCompare(b.name_ru));
  const nodes = new Map<string, CategoryNode>(
    sorted.map((r) => [r.id, { id: r.id, slug: r.slug, name_ru: r.name_ru, name_uz: r.name_uz, product_count: 0, children: [] }]),
  );
  const trees: CategoryTrees = { need: [], product_type: [] };

  for (const r of sorted) {
    const node = nodes.get(r.id)!;
    if (!r.parent_id) {
      trees[r.tree_type].push(node);
      continue;
    }
    nodes.get(r.parent_id)?.children.push(node);
  }
  // A product in "Витамин D" and in "Витамины" is counted once for "Витамины".
  const count = (node: CategoryNode): Set<string> => {
    const ids = new Set(productsByCategory.get(node.id));
    for (const child of node.children) for (const id of count(child)) ids.add(id);
    node.product_count = ids.size;
    return ids;
  };
  [...trees.need, ...trees.product_type].forEach(count);
  return trees;
}

/** Drops categories (and subcategories) that have no visible products. */
export function pruneEmpty(trees: CategoryTrees): CategoryTrees {
  const prune = (nodes: CategoryNode[]): CategoryNode[] =>
    nodes.filter((n) => n.product_count > 0).map((n) => ({ ...n, children: prune(n.children) }));
  return { need: prune(trees.need), product_type: prune(trees.product_type) };
}

/** The category itself plus all its descendants (filter "Витамины" must include "Витамин D"). */
export function collectDescendantIds(rows: Pick<CategoryRow, 'id' | 'parent_id'>[], rootId: string): string[] {
  const childrenOf = new Map<string, string[]>();
  for (const r of rows) {
    if (!r.parent_id) continue;
    childrenOf.set(r.parent_id, [...(childrenOf.get(r.parent_id) ?? []), r.id]);
  }
  const result: string[] = [];
  const queue = [rootId];
  while (queue.length) {
    const id = queue.shift()!;
    result.push(id);
    queue.push(...(childrenOf.get(id) ?? []));
  }
  return result;
}
