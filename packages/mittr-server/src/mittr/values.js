export const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export const isPlainObject = (value) => {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};
