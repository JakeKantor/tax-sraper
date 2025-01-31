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
  let page;

  try {
    // IMPORTANT: Same config as scraper.js
    browser = await puppeteer.launch({
      executablePath: "/usr/bin/chromium",
      headless: "new", // or true; "new" is Puppeteer 20+ recommended
      defaultViewport: null,
      devtools: false,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-infobars",
        "--window-position=0,0",
        "--window-size=1920,1080",
        '--user-agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
          'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Safari/537.36"',
      ],
    });

    page = await browser.newPage();

    // Set user-agent again at the page level (just like scraper.js)
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
        "AppleWebKit/537.36 (KHTML, like Gecko) " +
        "Chrome/112.0.0.0 Safari/537.36"
    );

    // 1) Navigate to the SmartAsset income tax calculator
    await page.goto("https://smartasset.com/taxes/income-taxes", {
      waitUntil: "networkidle2",
    });

    // 2) Select Filing Status
    await page.waitForSelector('span[id^="select2-chosen-"]', {
      visible: true,
    });
    await page.click('span[id^="select2-chosen-"]');

    // Wait for the dropdown options to appear
    await page.waitForSelector("ul.select2-results li", { visible: true });

    const filingStatusMap = {
      Single: "Single",
      "Married Filing Jointly": "Married",
      "Married Filing Separately": "Married Separately",
      "Head of Household": "Head of Household",
    };
    const optionText = filingStatusMap[filingStatus];

    // Evaluate to click the correct status in the dropdown
    await page.evaluate((optionText) => {
      const options = Array.from(
        document.querySelectorAll("ul.select2-results li")
      );
      const desiredOption = options.find(
        (el) => el.textContent.trim() === optionText
      );
      if (desiredOption) {
        desiredOption.click();
      }
    }, optionText);

    // 3) Enter Zip Code
    await page.waitForSelector('input[name="ud-current-location-display"]', {
      visible: true,
    });
    await page.evaluate(() => {
      document.querySelector(
        'input[name="ud-current-location-display"]'
      ).value = "";
    });
    await page.type('input[name="ud-current-location-display"]', zipcode, {
      delay: 100,
    });

    // Wait for the autocomplete dropdown and select the first option
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");

    // 4) Adjust salary by subtracting additionalWithholding
    //    (As you do in your logic)
    const adjustedSalary = salary;

    // 5) Enter Adjusted Annual Salary
    await page.waitForSelector("input.dollar", { visible: true });
    await page.evaluate((val) => {
      const input = document.querySelector("input.dollar");
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value"
      ).set;
      nativeInputValueSetter.call(input, val);
      ["input", "change", "blur"].forEach((eventName) => {
        const event = new Event(eventName, { bubbles: true });
        input.dispatchEvent(event);
      });
    }, adjustedSalary.toString());

    // Add a small delay and then press Enter
    await setTimeout(2000);
    await page.keyboard.press("Enter");

    // 6) Wait for the results to load
    await page.waitForSelector("span.income-after-taxes-next", {
      visible: true,
      timeout: 30000,
    });

    // 7) Extract the tax data
    const taxData = await page.evaluate(() => {
      const getTextContent = (selector) => {
        const el = document.querySelector(selector);
        return el ? el.textContent.trim() : null;
      };

      const parsePercentage = (txt) =>
        txt ? parseFloat(txt.replace("%", "")) : 0;
      const parseCurrency = (txt) =>
        txt ? parseFloat(txt.replace(/[$,]/g, "")) : 0;

      const data = {};

      data["Federal Withholding"] = {
        amount: parseCurrency(getTextContent("span.federal-amount-next")),
        effectiveRate: parsePercentage(
          getTextContent("span.federal-effective-rate")
        ),
      };

      data["State Tax Withholding"] = {
        amount: parseCurrency(getTextContent("span.state-amount-next")),
        effectiveRate: parsePercentage(
          getTextContent("span.state-effective-rate")
        ),
      };

      data["City Tax"] = {
        amount: parseCurrency(getTextContent("span.local-amount-next")),
        effectiveRate: parsePercentage(
          getTextContent("span.local-effective-rate")
        ),
      };

      data["FICA"] = {
        amount: parseCurrency(getTextContent("span.fica-amount-next")),
        effectiveRate: parsePercentage(
          getTextContent("span.fica-effective-rate")
        ),
      };

      data["Net Pay"] = parseCurrency(
        getTextContent("span.income-after-taxes-next")
      );

      return data;
    });

    // After extracting tax data, add this logging before returning:
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
  } finally {
    if (browser) {
      await browser.close();
    }
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
