const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const path = require("path");
const fs = require("fs");
const readline = require("readline");
const { compareTaxData } = require("./scraper2.js");

puppeteer.use(StealthPlugin());

/**
 * Helper function to clear and focus an input field.
 */
async function clearAndFocusField(page, selector) {
  // Triple-click to select all text
  await page.click(selector, { clickCount: 3 });

  // Small delay to ensure the field is properly focused
  await new Promise((resolve) => setTimeout(resolve, 400));

  // Press backspace multiple times to ensure clearing
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press("Backspace");
  }

  // Optionally, ensure .value = "" from the DOM side
  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (el) el.value = "";
  }, selector);
}

/**
 * Extract a tax value from the page for a given set of label(s).
 */
async function extractTaxValue(page, labels) {
  try {
    const taxValue = await page.evaluate((labels) => {
      for (const lbl of labels) {
        // Look for labels in different formats and locations
        const labelSelectors = [
          "div.form-group > div.form-label",
          "div.form-group > strong.form-label",
          "div.form-group > label.form-label",
          "div.form-label",
          "strong.form-label",
        ];

        for (const selector of labelSelectors) {
          const labelElements = Array.from(document.querySelectorAll(selector));
          const targetLabel = labelElements.find(
            (el) => el.textContent.trim() === lbl
          );

          if (targetLabel) {
            // Try different approaches to find the value
            const valueElement =
              targetLabel.parentElement.querySelector(
                "div.form-control-plaintext"
              ) ||
              targetLabel.parentElement.querySelector(
                "span.form-control-plaintext"
              ) ||
              targetLabel.nextElementSibling;

            if (valueElement) {
              const valueText = valueElement.textContent.trim();
              // Handle negative values with parentheses and remove currency symbols
              const cleanValue = valueText
                .replace(/[$,()]/g, "")
                .replace(/^\((.+)\)$/, "-$1");
              const value = parseFloat(cleanValue);
              return isNaN(value) ? 0 : value;
            }
          }
        }
      }
      return 0;
    }, labels);

    return taxValue;
  } catch (error) {
    console.log(`Error extracting tax for labels: ${labels.join(", ")}`);
    console.error(error);
    return 0;
  }
}

/**
 * Calculate Net Pay with up to 3 retry attempts if:
 *  - an error is thrown, or
 *  - the result is not within 1%
 *
 *  Returns an object with { taxDetails, percentages, isWithinThreshold }
 *  if successful, or false if all attempts fail.
 */
async function calculateNetPay(
  salary,
  withholding,
  state,
  address,
  city,
  zipcode,
  filingStatus
) {
  const maxAttempts = 3;
  let attempt = 0;

  while (attempt < maxAttempts) {
    attempt++;

    let browser;
    let page;
    try {
      const blockedResourceTypes = [
        "image",
        "media",
        "font",
        "texttrack",
        "object",
        "beacon",
        "csp_report",
        "imageset",
      ];

      const blockedDomains = ["ads.example.com", "doubleclick.net"];

      const processedState = state.toLowerCase().replace(/\s+/g, "-");

      browser = await puppeteer.launch({
        executablePath: "/usr/bin/chromium",
        headless: "new",
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
      await page.setUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
          "AppleWebKit/537.36 (KHTML, like Gecko) " +
          "Chrome/112.0.0.0 Safari/537.36"
      );

      // Intercept requests and block certain resource types/domains
      await page.setRequestInterception(true);
      page.on("request", (request) => {
        const url = request.url();
        const resourceType = request.resourceType();
        const isBlocked =
          blockedDomains.some((domain) => url.includes(domain)) ||
          blockedResourceTypes.includes(resourceType);

        if (isBlocked) {
          request.abort();
        } else {
          request.continue();
        }
      });

      // Go to PaycheckCity salary calculator
      await page.goto("https://www.paycheckcity.com/calculator/salary/", {
        waitUntil: "networkidle2",
      });

      const selectStateButtonSelector =
        'a.btn-text.underline[href="#select-state-calculator"]';
      await page.waitForSelector(selectStateButtonSelector, {
        visible: true,
        timeout: 30000,
      });
      await page.click(selectStateButtonSelector);

      // Try to close any pop-up ad
      const adCloseButtonSelector = ".ad-close-button";
      try {
        await page.waitForSelector(adCloseButtonSelector, {
          visible: true,
          timeout: 5000,
        });
        await page.click(adCloseButtonSelector);
      } catch (error) {
        // No pop-up ad or could not find it
      }

      // Wait for and click on the state link
      const stateListSelector = "ol.state-list-module--state-list--aaadc";
      await page.waitForSelector(stateListSelector, {
        visible: true,
        timeout: 30000,
      });

      const stateSelector = `a.btn-text.state-list-module--state-link--7b4b7[href="/calculator/salary/${processedState}"]`;
      await page.waitForSelector(stateSelector, {
        visible: true,
        timeout: 30000,
      });
      await page.click(stateSelector);

      // Hide ads with inline CSS
      const hideAdCSS = `
        .ad-container,
        #ad-modal,
        .popup-ad {
          display: none !important;
        }
      `;
      await page.addStyleTag({ content: hideAdCSS });

      // Helpers to verify if optional fields exist
      const address1Selector = "#stateInfo\\.local\\.address1";
      const citySelector = "#stateInfo\\.local\\.city";
      const zipSelector = "#stateInfo\\.local\\.zip";

      async function checkSelector(selector) {
        try {
          await page.waitForSelector(selector, {
            visible: true,
            timeout: 2000,
          });
          return true;
        } catch (error) {
          return false;
        }
      }

      // Fill out state-specific address info if those fields exist
      const addressExists = await checkSelector(address1Selector);
      const cityExists = await checkSelector(citySelector);
      const zipExists = await checkSelector(zipSelector);

      if (addressExists && cityExists && zipExists) {
        // Clear & focus the address field
        await clearAndFocusField(page, address1Selector);
        await page.type(address1Selector, address, { delay: 100 });

        // Clear & focus the city field
        await clearAndFocusField(page, citySelector);
        await page.type(citySelector, city, { delay: 100 });

        // Clear & focus the zip field
        await clearAndFocusField(page, zipSelector);
        await page.type(zipSelector, zipcode, { delay: 100 });

        // If the state filing status selector is present, set it
        const stateFilingStatusSelector = "#stateInfo\\.parms\\.FILINGSTATUS";
        const stateFilingStatusExists = await checkSelector(
          stateFilingStatusSelector
        );

        if (stateFilingStatusExists) {
          let stateFilingStatus;
          if (filingStatus === "MARRIED") {
            stateFilingStatus = "M";
          } else if (filingStatus === "MARRIED_USE_SINGLE_RATE") {
            stateFilingStatus = "MH";
          } else {
            stateFilingStatus = "S";
          }
          await page.select(stateFilingStatusSelector, stateFilingStatus);
        }
      }

      // Fill out salary
      const grossPaySelector = "#grossPay";
      await page.waitForSelector(grossPaySelector, {
        visible: true,
        timeout: 30000,
      });

      // Clear & focus the salary field
      await clearAndFocusField(page, grossPaySelector);
      await page.type(grossPaySelector, salary.toString(), { delay: 100 });

      // Set pay frequency to Annual
      const payFrequencySelector = "#payFrequency";
      await page.waitForSelector(payFrequencySelector, {
        visible: true,
        timeout: 30000,
      });
      await page.select(payFrequencySelector, "ANNUAL");

      // Ensure "W4 2020 and later" is checked
      const w42020Selector = "#w42020";
      await page.waitForSelector(w42020Selector, {
        visible: true,
        timeout: 30000,
      });
      const isChecked = await page.$eval(w42020Selector, (el) => el.checked);
      if (!isChecked) {
        await page.click(w42020Selector);
      }

      // Select the federal filing status
      const filingStatusSelector = "#federalFilingStatusType2020";
      await page.waitForSelector(filingStatusSelector, {
        visible: true,
        timeout: 30000,
      });
      await page.select(filingStatusSelector, filingStatus);

      // Click the "Calculate" button
      const calculateButtonSelector = 'button[type="submit"].btn.btn-primary';
      await page.waitForSelector(calculateButtonSelector, {
        visible: true,
        timeout: 30000,
      });
      await page.click(calculateButtonSelector);

      // Wait until "Take home pay (net pay)" is present
      const netPayLabelSelector = "strong.form-label";
      await page.waitForFunction(
        (selector) => {
          const elements = Array.from(document.querySelectorAll(selector));
          return elements.some(
            (el) => el.innerText.trim() === "Take home pay (net pay)"
          );
        },
        { timeout: 120000 },
        netPayLabelSelector
      );

      // Extract tax categories
      const taxCategories = [
        {
          name: "Net Pay",
          labels: ["Take home pay (net pay)", "Net Pay", "Take Home Pay"],
        },
        {
          name: "Federal Withholding",
          labels: ["Federal Withholding", "Federal Income Tax Withholding"],
        },
        {
          name: "State Tax Withholding",
          labels: [
            "State Tax Withholding",
            "State Income Tax Withholding",
            "State Withholding",
          ],
        },
        {
          name: "City Tax",
          labels: ["City Tax", "Local Tax Withholding", "City Income Tax"],
        },
        {
          name: "Medicare",
          labels: ["Medicare", "Medicare Tax"],
        },
        {
          name: "Social Security",
          labels: ["Social Security", "Social Security Tax", "OASDI"],
        },
        {
          name: "State Disability Insurance (SDI)",
          labels: [
            "State Disability Insurance (SDI)",
            "SDI",
            "State Disability",
          ],
        },
        {
          name: "Family Leave Insurance (FLI)",
          labels: [
            "Family Leave Insurance (FLI)",
            "FLI",
            "Family Leave Insurance",
          ],
        },
      ];

      const taxDetails = {};
      for (const category of taxCategories) {
        const value = await extractTaxValue(page, category.labels);
        taxDetails[category.name] = value;
      }

      // Prepare the data to compare with your reference (scraper2.js)
      const taxDataToCompare = {
        "Federal Withholding": taxDetails["Federal Withholding"],
        "State Tax Withholding": taxDetails["State Tax Withholding"],
        "City Tax": taxDetails["City Tax"],
        Medicare: taxDetails["Medicare"],
        "Social Security": taxDetails["Social Security"],
      };

      // Convert your raw filing status to the label used by compareTaxData
      const filingStatusMap = {
        SINGLE: "Single",
        MARRIED: "Married Filing Jointly",
        HEAD_OF_HOUSEHOLD: "Head of Household",
        NONRESIDENT_ALIEN: "Single",
      };
      const adjustedFilingStatus = filingStatusMap[filingStatus];

      // Compare results
      const { isWithinThreshold } = await compareTaxData(
        salary,
        adjustedFilingStatus,
        zipcode,
        withholding,
        taxDataToCompare
      );

      const totalTax =
        taxDetails["Federal Withholding"] +
        taxDetails["State Tax Withholding"] +
        taxDetails["City Tax"] +
        taxDetails["Medicare"] +
        taxDetails["Social Security"] +
        taxDetails["Family Leave Insurance (FLI)"] +
        taxDetails["State Disability Insurance (SDI)"];

      const percentages = {};
      [
        "Federal Withholding",
        "State Tax Withholding",
        "City Tax",
        "Medicare",
        "Social Security",
        "Family Leave Insurance (FLI)",
        "State Disability Insurance (SDI)",
      ].forEach((key) => {
        const pct = (taxDetails[key] / salary) * 100;
        percentages[key] = pct.toFixed(2) + "%";
      });

      // Add print statements for PaycheckCity results
      console.log("\n=== PaycheckCity.com Tax Calculation Results ===");
      console.log("Federal Withholding:");
      console.log(
        `  Amount: $${taxDetails["Federal Withholding"].toLocaleString()}`
      );
      console.log(`  Rate: ${percentages["Federal Withholding"]}`);

      console.log("\nState Tax Withholding:");
      console.log(
        `  Amount: $${taxDetails["State Tax Withholding"].toLocaleString()}`
      );
      console.log(`  Rate: ${percentages["State Tax Withholding"]}`);

      console.log("\nCity Tax:");
      console.log(`  Amount: $${taxDetails["City Tax"].toLocaleString()}`);
      console.log(`  Rate: ${percentages["City Tax"]}`);

      console.log("\nFICA:");
      const ficaAmount = taxDetails["Medicare"] + taxDetails["Social Security"];
      const ficaRate = ((ficaAmount / salary) * 100).toFixed(2);
      console.log(`  Amount: $${ficaAmount.toLocaleString()}`);
      console.log(`  Rate: ${ficaRate}%`);

      console.log(`\nNet Pay: $${taxDetails["Net Pay"].toLocaleString()}`);
      console.log("============================\n");

      // Pass/fail based on threshold:
      if (isWithinThreshold) {
        console.log(`Attempt ${attempt}: PASSED (within 1%)`);
        // Return the tax details object + percentages (or anything else) only if success
        return {
          isWithinThreshold,
          percentages,
        };
      } else {
        console.log(`Attempt ${attempt}: FAILED (not within 1%). Retrying...`);
      }
    } catch (error) {
      console.error(`Attempt ${attempt} failed with error:`, error);
    } finally {
      // Always close browser before moving on
      if (browser) {
        await browser.close();
      }
    }
  }

  // If all attempts fail, return false
  console.log(`All ${maxAttempts} attempts failed for state: ${state}`);
  return false;
}

async function main() {
  const result = await calculateNetPay(
    65000,
    0,
    "New York",
    "35 Hudson Yards",
    "New York",
    "10001",
    "SINGLE"
  );

  // 65000,
  // 0,
  // "Florida",
  // "5122 Forestgreen Dr E",
  // "Lakeland",
  // "33811",
  // "SINGLE"
  console.log("API Result:", JSON.stringify(result, null, 2));
}

module.exports = {
  calculateNetPay
};