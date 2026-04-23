/**
 * Lead scoring — returns a score between 1 and 10.
 */
function calculateScore(data) {
  let score = 0;

  // Interest
  const intent = (data.intent || '').toLowerCase();
  if (intent === 'buy')  score += 3;
  else if (intent === 'sell') score += 2;
  else if (intent === 'rent') score += 1;

  // Budget
  const budget = (data.budget || '').toLowerCase();
  if (budget.includes('above 5m') || budget.includes('above_5m')) score += 4;
  else if (budget.includes('2m') && budget.includes('5m'))         score += 3;
  else if (budget.includes('1m') && budget.includes('2m'))         score += 2;
  else if (budget.includes('500k') || budget.includes('500k'))     score += 1;

  // Area
  const area = (data.area || '').toLowerCase();
  if (area.includes('palm'))                              score += 2;
  else if (area.includes('downtown') || area.includes('marina')) score += 1;

  // Property type
  const type = (data.propertyType || '').toLowerCase();
  if (type.includes('villa')) score += 1;

  return Math.max(1, Math.min(10, score));
}

module.exports = { calculateScore };
