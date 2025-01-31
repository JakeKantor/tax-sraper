const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const { setTimeout } = require("timers/promises"); // For small delays

// Enable stealth mode
puppeteer.use(StealthPlugin());

/**
 * Calculate net pay and return tax data.
 */
async function calculateNetPay(
  salary,
  filingStatus,
  zipcode,
  additionalWithholding
) {
  let browser;
  try {
    // Construct API URL with parameters
    console.log("Filing Status:", filingStatus);
    const apiUrl = `https://smartasset.com/taxes/income-taxes?render=json&ud-it-household-income=${salary}&ud-married=${
      filingStatus === "Married Filing Jointly" ? 1 : 0
    }&ud-current-location=ZIP|${zipcode}`;

    // Make direct API request using fetch
    const response = await fetch(apiUrl);
    const data = await response.json();

    // Extract 2024 tax data
    const taxData2024 = data.page_data["2024"];

    // Format the response to match existing structure
    const taxData = {
      "Federal Withholding": {
        amount: taxData2024.federalTax,
        effectiveRate: taxData2024.federalEffectiveRate,
      },
      "State Tax Withholding": {
        amount: taxData2024.stateTax,
        effectiveRate: taxData2024.stateEffectiveRate,
      },
      "City Tax": {
        amount: taxData2024.localTax,
        effectiveRate: taxData2024.localEffectiveRate,
      },
      FICA: {
        amount: taxData2024.ficaTax,
        effectiveRate: taxData2024.ficaEffectiveRate,
      },
      "Net Pay": taxData2024.takeHomePay,
    };

    // Log results (keeping existing logging format)
    console.log("\n=== smartasset.com Tax Calculation Results ===");
    console.log("Federal Withholding:");
    console.log(
      `  Amount: $${taxData["Federal Withholding"].amount.toLocaleString()}`
    );
    console.log(`  Rate: ${taxData["Federal Withholding"].effectiveRate}%`);

    console.log("\nState Tax Withholding:");
    console.log(
      `  Amount: $${taxData["State Tax Withholding"].amount.toLocaleString()}`
    );
    console.log(`  Rate: ${taxData["State Tax Withholding"].effectiveRate}%`);

    console.log("\nCity Tax:");
    console.log(`  Amount: $${taxData["City Tax"].amount.toLocaleString()}`);
    console.log(`  Rate: ${taxData["City Tax"].effectiveRate}%`);

    console.log("\nFICA:");
    console.log(`  Amount: $${taxData["FICA"].amount.toLocaleString()}`);
    console.log(`  Rate: ${taxData["FICA"].effectiveRate}%`);

    console.log(`\nNet Pay: $${taxData["Net Pay"].toLocaleString()}`);
    console.log("============================\n");

    return taxData;
  } catch (error) {
    console.error("An error occurred in scraper2.js:", error);
    throw error;
  }
}

/**
 * Compare tax data and return { isWithinThreshold, taxData }
 */
async function compareTaxData(
  salary,
  filingStatus,
  zipcode,
  additionalWithholding,
  taxDataToCompare
) {
  try {
    // Get tax data from calculateNetPay
    const taxData = await calculateNetPay(
      salary,
      filingStatus,
      zipcode,
      additionalWithholding
    );

    // Calculate total deductions from PaycheckCity (including all categories)
    const paycheckCityTotal =
      taxDataToCompare["Federal Withholding"] +
      taxDataToCompare["State Tax Withholding"] +
      taxDataToCompare["City Tax"] +
      taxDataToCompare["Medicare"] +
      taxDataToCompare["Social Security"] +
      (taxDataToCompare["State Disability Insurance (SDI)"] || 0) +
      (taxDataToCompare["Family Leave Insurance (FLI)"] || 0);

    // Calculate total deductions from SmartAsset
    const smartAssetTotal =
      taxData["Federal Withholding"].amount +
      taxData["State Tax Withholding"].amount +
      taxData["City Tax"].amount +
      taxData["FICA"].amount;

    // Combine "Medicare" + "Social Security" from taxDataToCompare to get "FICA"
    const ficaFromPaycheckCity =
      taxDataToCompare["Medicare"] + taxDataToCompare["Social Security"];

    console.log("\n=== Detailed Tax Comparison ===");

    // Compare core categories (as percentages)
    const categories = [
      {
        name: "Federal Withholding",
        smartAsset: taxData["Federal Withholding"].amount,
        paycheckCity: taxDataToCompare["Federal Withholding"],
      },
      {
        name: "State Tax Withholding",
        smartAsset: taxData["State Tax Withholding"].amount,
        paycheckCity: taxDataToCompare["State Tax Withholding"],
      },
      {
        name: "City Tax",
        smartAsset: taxData["City Tax"].amount,
        paycheckCity: taxDataToCompare["City Tax"],
      },
      {
        name: "FICA",
        smartAsset: taxData["FICA"].amount,
        paycheckCity: ficaFromPaycheckCity,
      },
    ];

    let withinThreshold = true;
    console.log("\nCore Tax Categories:");
    for (const category of categories) {
      const smartAssetPct = (category.smartAsset / salary) * 100;
      const paycheckCityPct = (category.paycheckCity / salary) * 100;
      const diff = Math.abs(smartAssetPct - paycheckCityPct);

      console.log(`\n${category.name}:`);
      console.log(
        `  SmartAsset:   $${category.smartAsset.toLocaleString()} (${smartAssetPct.toFixed(
          2
        )}%)`
      );
      console.log(
        `  PaycheckCity: $${category.paycheckCity.toLocaleString()} (${paycheckCityPct.toFixed(
          2
        )}%)`
      );
      console.log(`  Difference:   ${diff.toFixed(2)}%`);

      if (diff > 1) {
        console.log(`  ❌ Exceeds 1% threshold`);
        withinThreshold = false;
      } else {
        console.log(`  ✓ Within threshold`);
      }
    }

    // Log additional PaycheckCity categories not in SmartAsset
    console.log("\nAdditional PaycheckCity Categories (not in SmartAsset):");
    const additionalCategories = [
      "State Disability Insurance (SDI)",
      "Family Leave Insurance (FLI)",
    ];

    for (const category of additionalCategories) {
      const amount = taxDataToCompare[category] || 0;
      const percentage = (amount / salary) * 100;
      if (amount > 0) {
        console.log(`\n${category}:`);
        console.log(`  Amount: $${amount.toLocaleString()}`);
        console.log(`  Rate:   ${percentage.toFixed(2)}%`);
      }
    }

    // Compare total deductions
    const totalDiffAmount = Math.abs(paycheckCityTotal - smartAssetTotal);
    const totalDiffPct = (totalDiffAmount / salary) * 100;

    console.log("\nTotal Deductions:");
    console.log(
      `  SmartAsset:   $${smartAssetTotal.toLocaleString()} (${(
        (smartAssetTotal / salary) *
        100
      ).toFixed(2)}%)`
    );
    console.log(
      `  PaycheckCity: $${paycheckCityTotal.toLocaleString()} (${(
        (paycheckCityTotal / salary) *
        100
      ).toFixed(2)}%)`
    );
    console.log(
      `  Difference:   $${totalDiffAmount.toLocaleString()} (${totalDiffPct.toFixed(
        2
      )}%)`
    );

    if (totalDiffPct > 1) {
      console.log("  ❌ Total difference exceeds 1% threshold");
    } else {
      console.log("  ✓ Total within threshold");
    }

    console.log("\n============================");

    return {
      isWithinThreshold: withinThreshold,
      taxData,
      comparison: {
        smartAssetTotal,
        paycheckCityTotal,
        totalDiffAmount,
        totalDiffPct,
      },
    };
  } catch (error) {
    console.error("Error in compareTaxData:", error);
    throw error;
  }
}

// Export the function so scraper.js can call it
module.exports = { compareTaxData };
