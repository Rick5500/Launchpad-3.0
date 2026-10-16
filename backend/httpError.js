function httpError(status, publicMessage) {
  const error = new Error(publicMessage);
  error.status = status;
  error.publicMessage = publicMessage;
  return error;
}

function sendError(res, err, label, fallback) {
  if (err && err.status && err.publicMessage) {
    return res.status(err.status).json({ error: err.publicMessage });
  }
  console.error(label, err);
  return res.status(500).json({ error: fallback });
}

module.exports = {
  httpError,
  sendError,
};
