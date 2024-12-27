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
      executablePath: '/usr/bin/chromium',
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
    const adjustedSalary = salary - additionalWithholding;

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

    // Combine "Medicare" + "Social Security" from taxDataToCompare to get "FICA"
    const ficaFromOther =
      taxDataToCompare["Medicare"] + taxDataToCompare["Social Security"];

    const categories = [
      "Federal Withholding",
      "State Tax Withholding",
      "City Tax",
      "FICA",
    ];

    // Compute percentages for each category from taxData
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
    const percentagesOther = {
      "Federal Withholding":
        (taxDataToCompare["Federal Withholding"] / salary) * 100,
      "State Tax Withholding":
        (taxDataToCompare["State Tax Withholding"] / salary) * 100,
      "City Tax": (taxDataToCompare["City Tax"] / salary) * 100,
      FICA: (ficaFromOther / salary) * 100,
    };

    // Compare the percentages
    let withinThreshold = true;
    for (const category of categories) {
      const diff = Math.abs(
        percentagesCalculated[category] - percentagesOther[category]
      );
      if (diff > 1) {
        withinThreshold = false;
        break;
      }
    }

    return { isWithinThreshold: withinThreshold, taxData };
  } catch (error) {
    console.error("Error in compareTaxData:", error);
    throw error;
  }
}

// Export the function so scraper.js can call it
module.exports = { compareTaxData };
