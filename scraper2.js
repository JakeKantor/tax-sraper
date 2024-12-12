const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const { setTimeout } = require("timers/promises"); // Import setTimeout for delays

// Enable stealth mode with default configurations
puppeteer.use(StealthPlugin());

// Function to calculate net pay and return tax data
async function calculateNetPay(
  salary,
  filingStatus,
  zipcode,
  additionalWithholding
) {
  let browser;
  let page;

  try {
    // Adjust salary by subtracting additional withholding
    const adjustedSalary = salary - additionalWithholding;

    // Launch Puppeteer browser with headless: true
    browser = await puppeteer.launch({ headless: true });
    page = await browser.newPage();

    // Set User-Agent
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
        "AppleWebKit/537.36 (KHTML, like Gecko) " +
        "Chrome/112.0.0.0 Safari/537.36"
    );

    // Navigate to the SmartAsset income tax calculator
    await page.goto("https://smartasset.com/taxes/income-taxes", {
      waitUntil: "networkidle2",
    });

    // Select Filing Status
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

    await page.evaluate((optionText) => {
      const options = Array.from(document.querySelectorAll("ul.select2-results li"));
      const desiredOption = options.find(
        (el) => el.textContent.trim() === optionText
      );
      if (desiredOption) {
        desiredOption.click();
      }
    }, optionText);

    // Enter Zip Code
    await page.waitForSelector('input[name="ud-current-location-display"]', {
      visible: true,
    });
    await page.evaluate(() => {
      document.querySelector('input[name="ud-current-location-display"]').value = "";
    });
    await page.type('input[name="ud-current-location-display"]', zipcode, {
      delay: 100,
    });

    // Wait for the autocomplete dropdown and select the first option
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");

    // Enter Adjusted Annual Salary using Native Input Value Setter
    await page.waitForSelector('input.dollar', { visible: true });

    await page.evaluate((salary) => {
      const input = document.querySelector('input.dollar');
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value"
      ).set;
      nativeInputValueSetter.call(input, salary);
      const events = ["input", "change", "blur"];
      events.forEach((eventName) => {
        const event = new Event(eventName, { bubbles: true });
        input.dispatchEvent(event);
      });
    }, adjustedSalary.toString());

    // Add a timeout before pressing "Enter"
    await setTimeout(2000);
    await page.keyboard.press("Enter");

    // Wait for the results to load
    await page.waitForSelector("span.income-after-taxes-next", {
      visible: true,
      timeout: 30000,
    });

    const taxData = await page.evaluate(() => {
      const getTextContent = (selector) => {
        const element = document.querySelector(selector);
        return element ? element.textContent.trim() : null;
      };

      const parsePercentage = (text) => {
        return text ? parseFloat(text.replace("%", "")) : 0;
      };

      const parseCurrency = (text) => {
        return text ? parseFloat(text.replace(/[$,]/g, "")) : 0;
      };

      const data = {};

      data["Federal Withholding"] = {
        amount: parseCurrency(getTextContent("span.federal-amount-next")),
        effectiveRate: parsePercentage(getTextContent("span.federal-effective-rate")),
      };

      data["State Tax Withholding"] = {
        amount: parseCurrency(getTextContent("span.state-amount-next")),
        effectiveRate: parsePercentage(getTextContent("span.state-effective-rate")),
      };

      data["City Tax"] = {
        amount: parseCurrency(getTextContent("span.local-amount-next")),
        effectiveRate: parsePercentage(getTextContent("span.local-effective-rate")),
      };

      data["FICA"] = {
        amount: parseCurrency(getTextContent("span.fica-amount-next")),
        effectiveRate: parsePercentage(getTextContent("span.fica-effective-rate")),
      };

      data["Net Pay"] = parseCurrency(getTextContent("span.income-after-taxes-next"));

      return data;
    });

    return taxData;
  } catch (error) {
    console.error(
      "An error occurred during the Puppeteer script execution:",
      error
    );
    if (browser) {
      await browser.close();
    }
    throw error;
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

// Function to compare tax data and return both the boolean and the tax data
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

    // Add Medicare and Social Security from taxDataToCompare to get FICA
    const ficaFromOther =
      taxDataToCompare["Medicare"] + taxDataToCompare["Social Security"];

    const categories = ["Federal Withholding", "State Tax Withholding", "City Tax", "FICA"];

    // Compute percentages for each category from taxData (from calculateNetPay)
    const percentagesCalculated = {};
    for (const category of categories) {
      let amountCalculated;
      if (category === "FICA") {
        amountCalculated = taxData["FICA"].amount;
      } else {
        amountCalculated = taxData[category].amount;
      }
      percentagesCalculated[category] = (amountCalculated / salary) * 100;
    }

    // Compute percentages for each category from taxDataToCompare
    const percentagesOther = {};
    percentagesOther["Federal Withholding"] =
      (taxDataToCompare["Federal Withholding"] / salary) * 100;
    percentagesOther["State Tax Withholding"] =
      (taxDataToCompare["State Tax Withholding"] / salary) * 100;
    percentagesOther["City Tax"] =
      (taxDataToCompare["City Tax"] / salary) * 100;
    percentagesOther["FICA"] = (ficaFromOther / salary) * 100;

    // Compare the percentages
    let withinThreshold = true;
    for (const category of categories) {
      const percentCalculated = percentagesCalculated[category];
      const percentOther = percentagesOther[category];

      const difference = Math.abs(percentCalculated - percentOther);
      if (difference > 1.5) {
        withinThreshold = false;
        break;
      }
    }

    // Return both the boolean and the taxData so scraper.js can use it
    return { isWithinThreshold: withinThreshold, taxData };
  } catch (error) {
    console.error("Error in compareTaxData:", error);
    throw error;
  }
}

module.exports = { compareTaxData };