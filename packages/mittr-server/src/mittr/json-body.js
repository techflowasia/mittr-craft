export const INVALID_BODY = 'Invalid request body';

export const jsonBody = (express, { limit }) => {
  const parse = express.json({ limit });
  return (req, res, next) => parse(req, res, (error) => {
    if (!error) return next();
    return res.status(error.status ?? 400).json({ error: INVALID_BODY });
  });
};
