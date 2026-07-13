// Card index. Pure module: the raw database JSON is injected once via
// initCards(db) (the server reads assets/card_database.json, the client
// fetches it from /api/cards), after which card(id) resolves static card data.
// Game state itself only ever stores card *ids*, keeping it small and
// serializable.

let INDEX = null;

export function initCards(db) {
  INDEX = new Map();
  const add = (c, cardType) => {
    if (INDEX.has(c.id)) throw new Error(`Duplicate card id: ${c.id}`);
    INDEX.set(c.id, Object.freeze({ ...c, cardType }));
  };
  db.performers.forEach((c) => add(c, 'performer'));
  db.propsAndBackdrops.forEach((c) => add(c, c.cardKind)); // 'prop' | 'backdrop'
  db.trainers.forEach((c) => add(c, 'trainer'));
  db.resources.forEach((c) => add(c, 'resource'));
  db.favors.forEach((c) => add(c, 'favor'));
  db.rerolls.forEach((c) => add(c, 'reroll'));
}

export function cardsReady() {
  return INDEX !== null;
}

export function card(id) {
  const c = INDEX && INDEX.get(id);
  if (!c) throw new Error(`Unknown card id: ${id}`);
  return c;
}

export function allCardIds() {
  return [...INDEX.keys()];
}

// Card types that can occupy a mat slot (and carry hearts).
export const SLOTTABLE = new Set(['performer', 'backdrop', 'prop', 'trainer']);

export function isSlottable(id) {
  return SLOTTABLE.has(card(id).cardType);
}
