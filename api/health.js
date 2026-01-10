const { handleHealth } = require("../lib/api");

module.exports = async (req, res) => handleHealth(req, res);

