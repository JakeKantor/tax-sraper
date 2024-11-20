const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const path = require("path");
const fs = require("fs");
const readline = require("readline");

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
    // Attempt to find any of the possible labels
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
            // Remove $ and commas, then parse to float
            const value = parseFloat(
              valueElement.textContent.replace(/[$,]/g, "")
            );
            return isNaN(value) ? 0 : value;
          }
        }
      }
      return 0; // Return 0 if none of the labels are found
    }, labels);

    return taxValue;
  } catch (error) {
    console.log(`Error extracting tax for labels: ${labels.join(", ")}`);
    return 0;
  }
}

/**
 * Calculates net pay using PaycheckCity's salary calculator.
 *
 * @param {number} salary - The annual salary amount.
 * @param {number} withholding - The additional federal withholding amount.
 * @param {string} state - The U.S. state (case-insensitive, spaces will be replaced with hyphens).
 * @param {string} address - The work address.
 * @param {string} city - The city.
 * @param {string} zipcode - The ZIP code.
 * @param {string} filingStatus - The federal filing status.
 * @param {string} stateFilingStatus - The state filing status ('S', 'M', or 'MH').
 * @returns {Promise<void>} - Prints the calculated net pay and detailed tax information.
 */
async function calculateNetPay(
  salary,
  withholding,
  state,
  address,
  city,
  zipcode,
  filingStatus,
  stateFilingStatus
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
    // Add other ad domains identified
  ];

  // Process the state input: lowercase and replace spaces with hyphens
  const processedState = state.toLowerCase().replace(/\s+/g, "-");

  let browser;
  let page;

  try {
    // Connect Puppeteer to the scraping browser endpoint
    browser = await puppeteer.connect({
      browserWSEndpoint:
        "wss://brd-customer-hl_c86b85e7-zone-scraper_tax:7e3hc47mg10h@brd.superproxy.io:9222",
    });

    page = await browser.newPage();

    // Set User-Agent only if needed
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
        "AppleWebKit/537.36 (KHTML, like Gecko) " +
        "Chrome/112.0.0.0 Safari/537.36"
    );

    // Enable Request Interception for Blocking Ads
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

    // **Navigate to the Target Website**
    console.log("Navigating to the website...");
    await page.goto("https://www.paycheckcity.com/calculator/salary/", {
      waitUntil: "networkidle2",
    });
    console.log("Homepage loaded.");

    // **Click the "Select state" button**
    const selectStateButtonSelector =
      'a.btn-text.underline[href="#select-state-calculator"]';
    await page.waitForSelector(selectStateButtonSelector, {
      visible: true,
      timeout: 30000,
    });
    await page.click(selectStateButtonSelector);
    console.log('Clicked the "Select state" button.');

    // **Handle the Ad Popup (if it appears)**
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

    // **Wait for the State List to Appear**
    const stateListSelector = "ol.state-list-module--state-list--aaadc";
    await page.waitForSelector(stateListSelector, {
      visible: true,
      timeout: 30000,
    });
    console.log("State list is now visible.");

    // **Select the Specified State from the State List**
    const stateSelector = `a.btn-text.state-list-module--state-link--7b4b7[href="/calculator/salary/${processedState}"]`;
    await page.waitForSelector(stateSelector, {
      visible: true,
      timeout: 30000,
    });
    await page.click(stateSelector);
    console.log(`Selected "${state}" from the state list.`);

    // **Inject Custom CSS to Hide Any Remaining Ads**
    const hideAdCSS = `
      .ad-container,
      #ad-modal,
      .popup-ad
      {
        display: none !important;
      }
    `;
    await page.addStyleTag({ content: hideAdCSS });
    console.log("Injected custom CSS to hide any remaining ad elements.");

    // **Wait for Address Fields with Conditional Handling**
    const address1Selector = "#stateInfo\\.local\\.address1";
    const citySelector = "#stateInfo\\.local\\.city";
    const zipSelector = "#stateInfo\\.local\\.zip";

    // Function to check if a selector exists
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

    // Check if address fields are present
    const addressExists = await checkSelector(address1Selector);
    const cityExists = await checkSelector(citySelector);
    const zipExists = await checkSelector(zipSelector);

    if (addressExists && cityExists && zipExists) {
      console.log("Address fields are present. Proceeding to fill them.");

      // **Enter Work Address**
      await page.evaluate(() => {
        const addressInput = document.getElementById("stateInfo.local.address1");
        if (addressInput) addressInput.value = "";
      });
      await page.type(address1Selector, address, { delay: 100 });
      console.log(`Entered Work Address: "${address}".`);

      // **Enter City**
      await page.evaluate(() => {
        const cityInput = document.getElementById("stateInfo.local.city");
        if (cityInput) cityInput.value = "";
      });
      await page.type(citySelector, city, { delay: 100 });
      console.log(`Entered City: "${city}".`);

      // **Enter Zip Code**
      await page.evaluate(() => {
        const zipInput = document.getElementById("stateInfo.local.zip");
        if (zipInput) zipInput.value = "";
      });
      await page.type(zipSelector, zipcode, { delay: 100 });
      console.log(`Entered Zip Code: "${zipcode}".`);

      // **Set State Filing Status if Applicable**
      const stateFilingStatusSelector = "#stateInfo\\.parms\\.FILINGSTATUS";
      const stateFilingStatusExists = await checkSelector(
        stateFilingStatusSelector
      );

      if (stateFilingStatusExists) {
        await page.select(stateFilingStatusSelector, stateFilingStatus);
        console.log(`Set state filing status to "${stateFilingStatus}".`);
      } else {
        console.log(
          "State filing status selector not found. Skipping state filing status."
        );
      }
    } else {
      console.log(
        "Address fields not found. Skipping address, city, and ZIP code entry."
      );
    }

    // **Set Salary Amount**
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

    // **Select Pay Frequency as Annual**
    const payFrequencySelector = "#payFrequency";
    await page.waitForSelector(payFrequencySelector, {
      visible: true,
      timeout: 30000,
    });
    await page.select(payFrequencySelector, "ANNUAL");
    console.log("Selected pay frequency as Annual.");

    // **Check W4 2020 Checkbox if Unchecked**
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

    // **Set Federal Filing Status**
    const filingStatusSelector = "#federalFilingStatusType2020";
    await page.waitForSelector(filingStatusSelector, {
      visible: true,
      timeout: 30000,
    });
    await page.select(filingStatusSelector, filingStatus);
    console.log(`Set federal filing status to "${filingStatus}".`);

    // **Click the Calculate Button**
    const calculateButtonSelector = 'button[type="submit"].btn.btn-primary';
    await page.waitForSelector(calculateButtonSelector, {
      visible: true,
      timeout: 30000,
    });
    await page.click(calculateButtonSelector);
    console.log("Clicked the Calculate button.");

    // **Wait for the Results to Load**
    const netPayLabelSelector = "strong.form-label";
    await page.waitForFunction(
      (selector) => {
        const elements = Array.from(document.querySelectorAll(selector));
        return elements.some(
          (el) => el.innerText.trim() === "Take home pay (net pay)"
        );
      },
      { timeout: 60000 },
      netPayLabelSelector
    );
    console.log("Net Pay label found.");

    // **Extract and Return Net Pay and Tax Details**
    // Define the tax categories and their corresponding labels (including possible variations)
    const taxCategories = [
      { name: "Net Pay", labels: ["Take home pay (net pay)"] },
      { name: "Federal Withholding", labels: ["Federal Withholding"] },
      { name: "State Tax Withholding", labels: ["State Tax Withholding"] },
      { name: "City Tax", labels: ["City Tax"] },
      { name: "Medicare", labels: ["Medicare"] },
      { name: "Social Security", labels: ["Social Security"] },
      {
        name: "State Disability Insurance (SDI)",
        labels: ["State Disability Insurance (SDI)"],
      },
      {
        name: "Family Leave Insurance (FLI)",
        labels: ["Family Leave Insurance (FLI)"],
      },
      // Add more categories or label variations as needed
    ];

    const taxDetails = {};

    for (const category of taxCategories) {
      const value = await extractTaxValue(page, category.labels);
      taxDetails[category.name] = value;
    }

    // Handle "Other" taxes by extracting any additional taxes not listed above
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

    // Calculate percentages
    const percentages = {};
    for (const [key, value] of Object.entries(taxDetails)) {
      percentages[key] = ((value / salary) * 100).toFixed(2) + "%";
    }

    // Ensure all taxDetails have numerical values before calling toLocaleString
    for (const key of Object.keys(taxDetails)) {
      if (typeof taxDetails[key] !== "number" || isNaN(taxDetails[key])) {
        taxDetails[key] = 0;
        percentages[key] = "0.00%";
      }
    }

    // Print detailed tax information
    console.log("\nDetailed Tax Information:");
    console.log(
      `1. Federal Withholding: $${taxDetails[
        "Federal Withholding"
      ].toLocaleString()} (${percentages["Federal Withholding"]})`
    );
    console.log(
      `2. State Tax Withholding: $${taxDetails[
        "State Tax Withholding"
      ].toLocaleString()} (${percentages["State Tax Withholding"]})`
    );
    console.log(
      `3. City Tax: $${taxDetails["City Tax"].toLocaleString()} (${percentages["City Tax"]})`
    );
    console.log(
      `4. Medicare: $${taxDetails["Medicare"].toLocaleString()} (${percentages["Medicare"]})`
    );
    console.log(
      `5. Social Security: $${taxDetails[
        "Social Security"
      ].toLocaleString()} (${percentages["Social Security"]})`
    );
    console.log(
      `6. Other Taxes: $${taxDetails["Other"].toLocaleString()} (${percentages["Other"]})`
    );

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

/**
 * Main function to execute the script.
 */
async function main() {
  try {
    console.log("Welcome to the Net Pay Calculator!");

    // **Prompt for Salary**
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

    // **Prompt for Withholding**
    let withholdingInput = await askQuestion(
      "Please enter your additional federal withholding amount (e.g., 10): "
    );
    let withholding = parseFloat(withholdingInput.replace(/[^0-9.]/g, ""));
    while (isNaN(withholding) || withholding < 0) {
      console.log("Invalid withholding. Please enter a non-negative number.");
      withholdingInput = await askQuestion(
        "Please enter your additional federal withholding amount (e.g., 10): "
      );
      withholding = parseFloat(withholdingInput.replace(/[^0-9.]/g, ""));
    }

    // **Prompt for State**
    let state = await askQuestion("Please enter your state (e.g., New York): ");
    while (!state.trim()) {
      console.log("State cannot be empty. Please enter a valid state.");
      state = await askQuestion("Please enter your state (e.g., New York): ");
    }

    // **Prompt for Address**
    let address = await askQuestion(
      "Please enter your work address (e.g., 35 Hudson Yards): "
    );
    while (!address.trim()) {
      console.log("Address cannot be empty. Please enter a valid address.");
      address = await askQuestion(
        "Please enter your work address (e.g., 35 Hudson Yards): "
      );
    }

    // **Prompt for City**
    let city = await askQuestion(
      "Please enter your city (e.g., Hudson Yards): "
    );
    while (!city.trim()) {
      console.log("City cannot be empty. Please enter a valid city.");
      city = await askQuestion(
        "Please enter your city (e.g., Hudson Yards): "
      );
    }

    // **Prompt for Zipcode**
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

    // **Prompt for Filing Status**
    console.log("Please select your filing status:");
    console.log("1. Single or Married Filing Separately");
    console.log("2. Married Filing Jointly");
    console.log("3. Head of Household");
    console.log("4. Nonresident Alien");
    let filingStatusInput = await askQuestion(
      "Enter the number corresponding to your filing status: "
    );
    let filingStatus = "";
    let stateFilingStatus = "";

    while (true) {
      filingStatusInput = filingStatusInput.trim();
      if (filingStatusInput === "1") {
        filingStatus = "SINGLE";
        stateFilingStatus = "S";
        break;
      } else if (filingStatusInput === "2") {
        filingStatus = "MARRIED";
        stateFilingStatus = "M";
        break;
      } else if (filingStatusInput === "3") {
        filingStatus = "HEAD_OF_HOUSEHOLD";
        stateFilingStatus = "S"; // Head of Household treated as Single for state taxes
        break;
      } else if (filingStatusInput === "4") {
        filingStatus = "NONRESIDENT_ALIEN";
        stateFilingStatus = "S";
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
      salary, // salary
      withholding, // withholding
      state, // state
      address, // address
      city, // city
      zipcode, // zipcode
      filingStatus, // federal filingStatus
      stateFilingStatus // state filingStatus
    );
  } catch (error) {
    console.error("Failed to calculate net pay:", error);
  }
}

// Execute the main function
main();