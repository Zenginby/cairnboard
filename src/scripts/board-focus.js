// Browsers do not scroll a focused element that is already partly visible, so a card in the next
// column could keep focus half outside the horizontally scrolling board. Bring the whole card in.
document.addEventListener('focusin', (event) => {
  const card = event.target instanceof Element ? event.target.closest('.board .board-card') : null;
  const board = card?.closest('.board');
  if (!board) return;
  const cardBox = card.getBoundingClientRect();
  const boardBox = board.getBoundingClientRect();
  if (cardBox.left >= boardBox.left && cardBox.right <= boardBox.right) return;
  card.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
});
