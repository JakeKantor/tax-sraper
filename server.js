const express = require("express");
const app = express();
const { calculateNetPay } = require("./scraper.js");

// Middleware to parse JSON bodies
app.use(express.json());

// Health check endpoint
app.get("/health", (req, res) => {
  res.status(200).json({ status: "healthy" });
});

// Tax calculation endpoint
app.post("/api/calculate-taxes", async (req, res) => {
  try {
    const { salary, withholding, state, address, city, zipcode, filingStatus } =
      req.body;

    // Validate required fields
    if (!salary || !state || !address || !city || !zipcode || !filingStatus) {
      return res.status(400).json({
        error: "Missing required fields",
        requiredFields: [
          "salary",
          "state",
          "address",
          "city",
          "zipcode",
          "filingStatus",
        ],
      });
    }

    const result = await calculateNetPay(
      salary,
      withholding || 0,
      state,
      address,
      city,
      zipcode,
      filingStatus
    );

    if (!result) {
      return res.status(500).json({
        error: "Failed to calculate taxes after multiple attempts",
      });
    }

    res.json(result);
  } catch (error) {
    console.error("API Error:", error);
    res.status(500).json({
      error: "Internal server error",
      message: error.message,
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
