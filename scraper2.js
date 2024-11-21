const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const readline = require("readline");
const { setTimeout } = require("timers/promises"); // Import setTimeout for delays

// Enable stealth mode with default configurations
puppeteer.use(StealthPlugin());

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

    // Launch Puppeteer browser with headless: false to see the browser actions
    browser = await puppeteer.launch({ headless: false });
    page = await browser.newPage();

    // Optional: Capture console logs from the page for debugging
    page.on("console", (msg) => console.log("PAGE LOG:", msg.text()));

    // Set User-Agent
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
        "AppleWebKit/537.36 (KHTML, like Gecko) " +
        "Chrome/112.0.0.0 Safari/537.36"
    );

    // Navigate to the SmartAsset income tax calculator
    console.log("Navigating to the SmartAsset income tax calculator...");
    await page.goto("https://smartasset.com/taxes/income-taxes", {
      waitUntil: "networkidle2",
    });
    console.log("Page loaded.");

    // Select Filing Status
    console.log(`Selecting filing status: ${filingStatus}`);
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

    console.log(`Filing status set to: ${filingStatus}`);

    // Enter Zip Code
    console.log(`Entering ZIP code: ${zipcode}`);
    await page.waitForSelector('input[name="ud-current-location-display"]', {
      visible: true,
    });
    await page.evaluate(() => {
      document.querySelector('input[name="ud-current-location-display"]').value =
        "";
    });
    await page.type('input[name="ud-current-location-display"]', zipcode, {
      delay: 100,
    });

    // Wait for the autocomplete dropdown and select the first option
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");

    console.log(`ZIP code set to: ${zipcode}`);

    // Enter Adjusted Annual Salary using Native Input Value Setter
    console.log(`Entering adjusted annual salary: $${adjustedSalary}`);
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
    await setTimeout(500); // Wait for 500 milliseconds
    await page.keyboard.press("Enter");

    // Wait for the results to load
    console.log("Calculating taxes...");
    await page.waitForSelector("span.income-after-taxes-next", {
      visible: true,
      timeout: 30000,
    });
    console.log("Calculation complete.");

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

    console.log("\nTax Breakdown:");
    let index = 1;
    for (const [taxType, details] of Object.entries(taxData)) {
      if (taxType === "Net Pay") {
        console.log(`\nYour adjusted net pay is: $${details.toLocaleString()}`);
      } else {
        console.log(
          `${index}. ${taxType}: $${details.amount.toLocaleString()} (${
            details.effectiveRate ? details.effectiveRate.toFixed(2) + "%" : ""
          })`
        );
        index++;
      }
    }
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

    let zipcode = await askQuestion(
      "Please enter your ZIP code (e.g., 10001): "
    );
    while (!/^\d{5}(-\d{4})?$/.test(zipcode.trim())) {
      console.log(
        "Invalid ZIP code. Please enter a 5-digit ZIP code or ZIP+4 format."
      );
      zipcode = await askQuestion("Please enter your ZIP code (e.g., 10001): ");
    }

    console.log("Please select your filing status:");
    console.log("1. Single");
    console.log("2. Married Filing Jointly");
    console.log("3. Married Filing Separately");
    console.log("4. Head of Household");
    let filingStatusInput = await askQuestion(
      "Enter the number corresponding to your filing status: "
    );
    let filingStatus = "";

    while (true) {
      filingStatusInput = filingStatusInput.trim();
      if (filingStatusInput === "1") {
        filingStatus = "Single";
        break;
      } else if (filingStatusInput === "2") {
        filingStatus = "Married Filing Jointly";
        break;
      } else if (filingStatusInput === "3") {
        filingStatus = "Married Filing Separately";
        break;
      } else if (filingStatusInput === "4") {
        filingStatus = "Head of Household";
        break;
      } else {
        console.log("Invalid input. Please enter a number between 1 and 4.");
        filingStatusInput = await askQuestion(
          "Enter the number corresponding to your filing status: "
        );
      }
    }

    let additionalWithholdingInput = await askQuestion(
      "Please enter your additional federal withholding amount (e.g., 4000): "
    );
    let additionalWithholding = parseFloat(
      additionalWithholdingInput.replace(/[^0-9.]/g, "")
    );
    while (isNaN(additionalWithholding) || additionalWithholding < 0) {
      console.log(
        "Invalid amount. Please enter a non-negative number for the additional withholding."
      );
      additionalWithholdingInput = await askQuestion(
        "Please enter your additional federal withholding amount (e.g., 4000): "
      );
      additionalWithholding = parseFloat(
        additionalWithholdingInput.replace(/[^0-9.]/g, "")
      );
    }

    console.log("\nCalculating your net pay... Please wait.\n");

    await calculateNetPay(
      salary,
      filingStatus,
      zipcode,
      additionalWithholding
    );
  } catch (error) {
    console.error("Failed to calculate net pay:", error);
  }
}

main();