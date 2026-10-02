import { buildCategoryTrees, CategoryRow, collectDescendantIds } from './category-tree';

const row = (id: string, parent_id: string | null, tree_type: CategoryRow['tree_type'], sort_order = 0): CategoryRow => ({
  id,
  parent_id,
  tree_type,
  slug: id,
  name_ru: id,
  name_uz: id,
  sort_order,
});

describe('buildCategoryTrees', () => {
  const rows = [
    row('vitamins', null, 'product_type', 10),
    row('vit-d', 'vitamins', 'product_type', 1),
    row('vit-c', 'vitamins', 'product_type', 0),
    row('immunity', null, 'need', 20),
    row('beauty', null, 'need', 10),
    row('skin', 'beauty', 'need'),
  ];

  it('splits rows into two trees and nests children', () => {
    const t = buildCategoryTrees(rows);
    expect(t.need.map((n) => n.slug)).toEqual(['beauty', 'immunity']);
    expect(t.need[0].children.map((n) => n.slug)).toEqual(['skin']);
    expect(t.product_type.map((n) => n.slug)).toEqual(['vitamins']);
  });

  it('orders siblings by sort_order', () => {
    expect(buildCategoryTrees(rows).product_type[0].children.map((n) => n.slug)).toEqual(['vit-c', 'vit-d']);
  });

  it('hides children whose parent is not in the active set', () => {
    const t = buildCategoryTrees([row('orphan', 'archived-parent', 'need'), row('grandchild', 'orphan', 'need')]);
    expect(t.need).toEqual([]);
  });
});

describe('collectDescendantIds', () => {
  it('returns the root and all levels below it', () => {
    const rows = [row('a', null, 'need'), row('b', 'a', 'need'), row('c', 'b', 'need'), row('x', null, 'need')];
    expect(collectDescendantIds(rows, 'a').sort()).toEqual(['a', 'b', 'c']);
    expect(collectDescendantIds(rows, 'x')).toEqual(['x']);
  });
});
