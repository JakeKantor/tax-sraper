const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const path = require("path");
const fs = require("fs");
const readline = require("readline");
const { compareTaxData } = require("./scraper2.js");

puppeteer.use(StealthPlugin());

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
    // Launch a local browser instance with options to simulate a real browser
    browser = await puppeteer.launch({
      headless: "new",
      defaultViewport: null,
      devtools: false,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-infobars',
        '--window-position=0,0',
        '--window-size=1920,1080',
        '--user-agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
          'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Safari/537.36"'
      ]
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

    console.log("Launched a local browser instance and ready to navigate.");
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
      // Add a leading space before typing
      await page.type(address1Selector, " " + address, { delay: 100 });
      console.log(`Entered Work Address: " ${address}".`);

      await page.evaluate(() => {
        const cityInput = document.getElementById("stateInfo.local.city");
        if (cityInput) cityInput.value = "";
      });
      // Add a leading space before typing city
      await page.type(citySelector, " " + city, { delay: 100 });
      console.log(`Entered City: " ${city}".`);

      await page.evaluate(() => {
        const zipInput = document.getElementById("stateInfo.local.zip");
        if (zipInput) zipInput.value = "";
      });
      // Add a leading space before typing ZIP
      await page.type(zipSelector, " " + zipcode, { delay: 100 });
      console.log(`Entered Zip Code: " ${zipcode}".`);

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
      { timeout: 120000 },
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

    // Extract each tax separately, including SDI and FLI
    for (const category of taxCategories) {
      const value = await extractTaxValue(page, category.labels);
      taxDetails[category.name] = value;
    }

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

    const { isWithinThreshold, taxData } = await compareTaxData(
      salary,
      adjustedFilingStatus,
      zipcode,
      withholding,
      taxDataToCompare
    );

    // Fill in zero values from taxData if available, if needed
    const categoriesToCheck = ["Federal Withholding", "State Tax Withholding", "City Tax", "Medicare", "Social Security"];
    for (const category of categoriesToCheck) {
      if (taxDetails[category] === 0) {
        if (category === "Medicare" || category === "Social Security") {
          if (taxData["FICA"] && taxData["FICA"].amount > 0) {
            const ficaAmount = taxData["FICA"].amount;
            const totalFicaRate = 7.65;
            const ssRatio = 6.2 / totalFicaRate;
            const medRatio = 1.45 / totalFicaRate;

            if (taxDetails["Medicare"] === 0) {
              taxDetails["Medicare"] = ficaAmount * medRatio;
              console.log(`\nNote: Medicare was 0%. Using scraper2's FICA to estimate Medicare.`);
            }
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

    // Recalculate percentages after potential updates
    for (const [key, value] of Object.entries(taxDetails)) {
      if (key !== "Net Pay") {
        percentages[key] = ((value / salary) * 100).toFixed(2) + "%";
      }
    }

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
      `6. Family Leave Insurance (FLI): $${taxDetails["Family Leave Insurance (FLI)"].toLocaleString()} (${percentages["Family Leave Insurance (FLI)"]})`
    );
    console.log(
      `7. State Disability Insurance (SDI): $${taxDetails["State Disability Insurance (SDI)"].toLocaleString()} (${percentages["State Disability Insurance (SDI)"]})`
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
    throw error;
  } finally {
    if (browser) {
      await browser.close();
      console.log("Browser closed successfully.");
    }
  }
}

async function main() {
  // Hardcoded test parameters
  const salary = 65000;
  const withholding = 0;
  const state = "New York";
  const address = "35 Hudson Yards";
  const city = "New York City";
  const zipcode = "10001";
  const filingStatus = "SINGLE";  // Options: "SINGLE", "MARRIED", "HEAD_OF_HOUSEHOLD", "NONRESIDENT_ALIEN"

  console.log("Welcome to the Net Pay Calculator!");
  console.log("Using hardcoded test parameters...\n");
  console.log(`Salary: ${salary}`);
  console.log(`Additional Withholding: ${withholding}`);
  console.log(`State: ${state}`);
  console.log(`Address: ${address}`);
  console.log(`City: ${city}`);
  console.log(`ZIP Code: ${zipcode}`);
  console.log(`Filing Status: ${filingStatus}`);

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
}

main();