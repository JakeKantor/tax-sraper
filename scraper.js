const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const path = require("path");
const fs = require("fs");
const readline = require("readline");

// Import compareTaxData from scraper2.js
const { compareTaxData } = require("./scraper2.js");

// Enable stealth mode with default configurations
puppeteer.use(StealthPlugin());

/**
 * Prompts the user for input via the console.
 *
 * @param {string} query - The question to display to the user.
 * @returns {Promise<string>} - The user's input.
 */
function askQuestion(query) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) =>
    rl.question(query, (ans) => {
      rl.close();
      resolve(ans);
    })
  );
}

/**
 * Extracts a single tax value based on its label.
 *
 * @param {object} page - The Puppeteer page instance.
 * @param {string[]} labels - An array of possible label variations.
 * @returns {Promise<number>} - The extracted tax amount or 0 if not found.
 */
async function extractTaxValue(page, labels) {
  try {
    const taxValue = await page.evaluate((labels) => {
      for (const lbl of labels) {
        const labelElements = Array.from(
          document.querySelectorAll("div.form-group > div.form-label")
        );
        const targetLabel = labelElements.find(
          (el) => el.textContent.trim() === lbl
        );
        if (targetLabel) {
          const valueElement = targetLabel.parentElement.querySelector(
            "div.form-control-plaintext"
          );
          if (valueElement) {
            const value = parseFloat(
              valueElement.textContent.replace(/[$,]/g, "")
            );
            return isNaN(value) ? 0 : value;
          }
        }
      }
      return 0;
    }, labels);

    return taxValue;
  } catch (error) {
    console.log(`Error extracting tax for labels: ${labels.join(", ")}`);
    return 0;
  }
}

async function calculateNetPay(
  salary,
  withholding,
  state,
  address,
  city,
  zipcode,
  filingStatus
) {
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

  const blockedDomains = [
    "ads.example.com",
    "doubleclick.net",
  ];

  const processedState = state.toLowerCase().replace(/\s+/g, "-");

  let browser;
  let page;

  try {
    browser = await puppeteer.connect({
      browserWSEndpoint:
        "wss://brd-customer-hl_c86b85e7-zone-scraper_tax:7e3hc47mg10h@brd.superproxy.io:9222",
    });

    page = await browser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
        "AppleWebKit/537.36 (KHTML, like Gecko) " +
        "Chrome/112.0.0.0 Safari/537.36"
    );

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

    console.log("Connected to the remote browser and ready to navigate.");
    await page.goto("https://www.paycheckcity.com/calculator/salary/", {
      waitUntil: "networkidle2",
    });
    console.log("Homepage loaded.");

    const selectStateButtonSelector =
      'a.btn-text.underline[href="#select-state-calculator"]';
    await page.waitForSelector(selectStateButtonSelector, {
      visible: true,
      timeout: 30000,
    });
    await page.click(selectStateButtonSelector);
    console.log('Clicked the "Select state" button.');

    const adCloseButtonSelector = ".ad-close-button";
    try {
      await page.waitForSelector(adCloseButtonSelector, {
        visible: true,
        timeout: 5000,
      });
      await page.click(adCloseButtonSelector);
      console.log("Closed the ad popup.");
    } catch (error) {
      console.log("Ad close button not found or ad did not appear.");
    }

    const stateListSelector = "ol.state-list-module--state-list--aaadc";
    await page.waitForSelector(stateListSelector, {
      visible: true,
      timeout: 30000,
    });
    console.log("State list is now visible.");

    const stateSelector = `a.btn-text.state-list-module--state-link--7b4b7[href="/calculator/salary/${processedState}"]`;
    await page.waitForSelector(stateSelector, {
      visible: true,
      timeout: 30000,
    });
    await page.click(stateSelector);
    console.log(`Selected "${state}" from the state list.`);

    const hideAdCSS = `
      .ad-container,
      #ad-modal,
      .popup-ad {
        display: none !important;
      }
    `;
    await page.addStyleTag({ content: hideAdCSS });
    console.log("Injected custom CSS to hide any remaining ad elements.");

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

    const addressExists = await checkSelector(address1Selector);
    const cityExists = await checkSelector(citySelector);
    const zipExists = await checkSelector(zipSelector);

    if (addressExists && cityExists && zipExists) {
      console.log("Address fields are present. Proceeding to fill them.");

      await page.evaluate(() => {
        const addressInput = document.getElementById("stateInfo.local.address1");
        if (addressInput) addressInput.value = "";
      });
      await page.type(address1Selector, address, { delay: 100 });
      console.log(`Entered Work Address: "${address}".`);

      await page.evaluate(() => {
        const cityInput = document.getElementById("stateInfo.local.city");
        if (cityInput) cityInput.value = "";
      });
      await page.type(citySelector, city, { delay: 100 });
      console.log(`Entered City: "${city}".`);

      await page.evaluate(() => {
        const zipInput = document.getElementById("stateInfo.local.zip");
        if (zipInput) zipInput.value = "";
      });
      await page.type(zipSelector, zipcode, { delay: 100 });
      console.log(`Entered Zip Code: "${zipcode}".`);

      const stateFilingStatusSelector = "#stateInfo\\.parms\\.FILINGSTATUS";
      const stateFilingStatusExists = await checkSelector(stateFilingStatusSelector);

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
        console.log(`Set state filing status to "${stateFilingStatus}".`);
      } else {
        console.log("State filing status selector not found. Skipping state filing status.");
      }
    } else {
      console.log("Address fields not found. Skipping address, city, and ZIP code entry.");
    }

    const grossPaySelector = "#grossPay";
    await page.waitForSelector(grossPaySelector, {
      visible: true,
      timeout: 30000,
    });
    await page.evaluate(() => {
      const grossPayInput = document.getElementById("grossPay");
      if (grossPayInput) grossPayInput.value = "";
    });
    await page.type(grossPaySelector, salary.toString(), { delay: 100 });
    console.log(`Entered salary amount: $${salary}.`);

    const payFrequencySelector = "#payFrequency";
    await page.waitForSelector(payFrequencySelector, {
      visible: true,
      timeout: 30000,
    });
    await page.select(payFrequencySelector, "ANNUAL");
    console.log("Selected pay frequency as Annual.");

    const w42020Selector = "#w42020";
    await page.waitForSelector(w42020Selector, {
      visible: true,
      timeout: 30000,
    });
    const isChecked = await page.$eval(w42020Selector, (el) => el.checked);
    if (!isChecked) {
      await page.click(w42020Selector);
      console.log("Checked W4 2020 checkbox.");
    } else {
      console.log("W4 2020 checkbox is already checked.");
    }

    const filingStatusSelector = "#federalFilingStatusType2020";
    await page.waitForSelector(filingStatusSelector, {
      visible: true,
      timeout: 30000,
    });
    await page.select(filingStatusSelector, filingStatus);
    console.log(`Set federal filing status to "${filingStatus}".`);

    const calculateButtonSelector = 'button[type="submit"].btn.btn-primary';
    await page.waitForSelector(calculateButtonSelector, {
      visible: true,
      timeout: 30000,
    });
    await page.click(calculateButtonSelector);
    console.log("Clicked the Calculate button.");

    const netPayLabelSelector = "strong.form-label";
    await page.waitForFunction(
      (selector) => {
        const elements = Array.from(document.querySelectorAll(selector));
        return elements.some(
          (el) => el.innerText.trim() === "Take home pay (net pay)"
        );
      },
      { timeout: 120000 },//100000
      netPayLabelSelector
    );
    console.log("Net Pay label found.");

    const taxCategories = [
      { name: "Net Pay", labels: ["Take home pay (net pay)"] },
      { name: "Federal Withholding", labels: ["Federal Withholding"] },
      { name: "State Tax Withholding", labels: ["State Tax Withholding"] },
      { name: "City Tax", labels: ["City Tax"] },
      { name: "Medicare", labels: ["Medicare"] },
      { name: "Social Security", labels: ["Social Security"] },
      { name: "State Disability Insurance (SDI)", labels: ["State Disability Insurance (SDI)"] },
      { name: "Family Leave Insurance (FLI)", labels: ["Family Leave Insurance (FLI)"] },
    ];

    const taxDetails = {};

    for (const category of taxCategories) {
      const value = await extractTaxValue(page, category.labels);
      taxDetails[category.name] = value;
    }

    const otherTaxLabels = [
      "State Disability Insurance (SDI)",
      "Family Leave Insurance (FLI)",
    ];

    let otherTaxes = 0;
    for (const label of otherTaxLabels) {
      const value = await extractTaxValue(page, [label]);
      otherTaxes += value;
    }

    taxDetails["Other"] = otherTaxes;

    const percentages = {};
    for (const [key, value] of Object.entries(taxDetails)) {
      if (key !== "Net Pay") {
        percentages[key] = ((value / salary) * 100).toFixed(2) + "%";
      }
    }

    for (const key of Object.keys(taxDetails)) {
      if (typeof taxDetails[key] !== "number" || isNaN(taxDetails[key])) {
        taxDetails[key] = 0;
        if (key !== "Net Pay") {
          percentages[key] = "0.00%";
        }
      }
    }

    // Prepare taxDataToCompare object before calling compareTaxData
    const taxDataToCompare = {
      "Federal Withholding": taxDetails["Federal Withholding"],
      "State Tax Withholding": taxDetails["State Tax Withholding"],
      "City Tax": taxDetails["City Tax"],
      "Medicare": taxDetails["Medicare"],
      "Social Security": taxDetails["Social Security"],
    };

    const filingStatusMap = {
      SINGLE: "Single",
      MARRIED: "Married Filing Jointly",
      HEAD_OF_HOUSEHOLD: "Head of Household",
      NONRESIDENT_ALIEN: "Single",
    };
    const adjustedFilingStatus = filingStatusMap[filingStatus];

    // Get isWithinThreshold and taxData from scraper2
    const { isWithinThreshold, taxData } = await compareTaxData(
      salary,
      adjustedFilingStatus,
      zipcode,
      withholding,
      taxDataToCompare
    );

    // Fill in zero values from taxData if available
    const categoriesToCheck = ["Federal Withholding", "State Tax Withholding", "City Tax", "Medicare", "Social Security"];
    for (const category of categoriesToCheck) {
      if (taxDetails[category] === 0) {
        if (category === "Medicare" || category === "Social Security") {
          // scraper2 gives only FICA total. If we have it, split proportionally:
          // Social Security: 6.2% of wages, Medicare: 1.45%, total 7.65%
          if (taxData["FICA"] && taxData["FICA"].amount > 0) {
            const ficaAmount = taxData["FICA"].amount;
            const totalFicaRate = 7.65;
            const ssRatio = 6.2 / totalFicaRate;
            const medRatio = 1.45 / totalFicaRate;

            // If Medicare is zero, fill from FICA
            if (taxDetails["Medicare"] === 0) {
              taxDetails["Medicare"] = ficaAmount * medRatio;
              console.log(`\nNote: Medicare was 0%. Using scraper2's FICA to estimate Medicare.`);
            }
            // If Social Security is zero, fill from FICA
            if (taxDetails["Social Security"] === 0) {
              taxDetails["Social Security"] = ficaAmount * ssRatio;
              console.log(`\nNote: Social Security was 0%. Using scraper2's FICA to estimate Social Security.`);
            }
          }
        } else {
          if (taxData[category] && taxData[category].amount > 0) {
            console.log(`\nNote: ${category} was 0%. Using scraper2 as reference.`);
            taxDetails[category] = taxData[category].amount;
          }
        }
      }
    }

    // Recalculate percentages after filling values
    for (const [key, value] of Object.entries(taxDetails)) {
      if (key !== "Net Pay") {
        percentages[key] = ((value / salary) * 100).toFixed(2) + "%";
      }
    }

    // Print detailed tax information after filling in missing values
    console.log("\nDetailed Tax Information:");
    console.log(
      `1. Federal Withholding: $${taxDetails["Federal Withholding"].toLocaleString()} (${percentages["Federal Withholding"]})`
    );
    console.log(
      `2. State Tax Withholding: $${taxDetails["State Tax Withholding"].toLocaleString()} (${percentages["State Tax Withholding"]})`
    );
    console.log(
      `3. City Tax: $${taxDetails["City Tax"].toLocaleString()} (${percentages["City Tax"]})`
    );
    console.log(
      `4. Medicare: $${taxDetails["Medicare"].toLocaleString()} (${percentages["Medicare"]})`
    );
    console.log(
      `5. Social Security: $${taxDetails["Social Security"].toLocaleString()} (${percentages["Social Security"]})`
    );
    console.log(
      `6. Other Taxes: $${taxDetails["Other"].toLocaleString()} (${percentages["Other"]})`
    );

    if (isWithinThreshold) {
      console.log("\nThe tax calculations are within 1.5%.");
    } else {
      console.log("\nThe tax calculations are not within 1.5%.");
    }

    return;
  } catch (error) {
    console.error(
      "An error occurred during the Puppeteer script execution:",
      error
    );
    if (page) {
      try {
        console.log("Error screenshot would have been saved at screenshots/error.png");
      } catch (screenshotError) {
        console.error("Failed to capture error screenshot:", screenshotError);
      }
    }
    if (browser) {
      await browser.close();
    }
    throw error; // Re-throw the error after cleanup
  } finally {
    if (browser) {
      await browser.close();
      console.log("Browser closed successfully.");
    }
  }
}

async function main() {
  try {
    console.log("Welcome to the Net Pay Calculator!");

    let salaryInput = await askQuestion(
      "Please enter your annual salary (e.g., 120000): "
    );
    let salary = parseFloat(salaryInput.replace(/[^0-9.]/g, ""));
    while (isNaN(salary) || salary <= 0) {
      console.log("Invalid salary. Please enter a positive number.");
      salaryInput = await askQuestion(
        "Please enter your annual salary (e.g., 120000): "
      );
      salary = parseFloat(salaryInput.replace(/[^0-9.]/g, ""));
    }

    let withholdingInput = await askQuestion(
      "Please enter your additional federal withholding amount (e.g., 4000): "
    );
    let withholding = parseFloat(withholdingInput.replace(/[^0-9.]/g, ""));
    while (isNaN(withholding) || withholding < 0) {
      console.log(
        "Invalid amount. Please enter a non-negative number for the additional withholding."
      );
      withholdingInput = await askQuestion(
        "Please enter your additional federal withholding amount (e.g., 4000): "
      );
      withholding = parseFloat(withholdingInput.replace(/[^0-9.]/g, ""));
    }

    let state = await askQuestion("Please enter your state (e.g., New York): ");
    while (!state.trim()) {
      console.log("State cannot be empty. Please enter a valid state.");
      state = await askQuestion("Please enter your state (e.g., New York): ");
    }

    let address = await askQuestion(
      "Please enter your work address (e.g., 35 Hudson Yards): "
    );
    while (!address.trim()) {
      console.log("Address cannot be empty. Please enter a valid address.");
      address = await askQuestion(
        "Please enter your work address (e.g., 35 Hudson Yards): "
      );
    }

    let city = await askQuestion("Please enter your city (e.g., New York): ");
    while (!city.trim()) {
      console.log("City cannot be empty. Please enter a valid city.");
      city = await askQuestion("Please enter your city (e.g., New York): ");
    }

    let zipcode = await askQuestion(
      "Please enter your ZIP code (e.g., 10001): "
    );
    while (!/^\d{5}(-\d{4})?$/.test(zipcode.trim())) {
      console.log(
        "Invalid ZIP code. Please enter a 5-digit ZIP code or ZIP+4 format."
      );
      zipcode = await askQuestion(
        "Please enter your ZIP code (e.g., 10001): "
      );
    }

    console.log("Please select your filing status:");
    console.log("1. Single or Married Filing Separately");
    console.log("2. Married Filing Jointly");
    console.log("3. Head of Household");
    console.log("4. Nonresident Alien");
    let filingStatusInput = await askQuestion(
      "Enter the number corresponding to your filing status: "
    );
    let filingStatus = "";

    while (true) {
      filingStatusInput = filingStatusInput.trim();
      if (filingStatusInput === "1") {
        filingStatus = "SINGLE";
        break;
      } else if (filingStatusInput === "2") {
        filingStatus = "MARRIED";
        break;
      } else if (filingStatusInput === "3") {
        filingStatus = "HEAD_OF_HOUSEHOLD";
        break;
      } else if (filingStatusInput === "4") {
        filingStatus = "NONRESIDENT_ALIEN";
        break;
      } else {
        console.log("Invalid input. Please enter a number between 1 and 4.");
        filingStatusInput = await askQuestion(
          "Enter the number corresponding to your filing status: "
        );
      }
    }

    console.log("\nCalculating your net pay... Please wait.\n");

    await calculateNetPay(
      salary,
      withholding,
      state,
      address,
      city,
      zipcode,
      filingStatus
    );
  } catch (error) {
    console.error("Failed to calculate net pay:", error);
  }
}

main();