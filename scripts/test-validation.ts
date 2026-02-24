import fs from "fs";

async function testUpload(filename: string, isCorrupted: boolean) {
  const formData = new FormData();

  let buffer;
  if (isCorrupted) {
    // Create a corrupted image (just random bytes)
    buffer = Buffer.from(
      Array.from({ length: 1000 }, () => Math.floor(Math.random() * 256)),
    );
  } else {
    // Create a 1x1 valid transparent PNG
    buffer = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
      "base64",
    );
  }

  formData.append("file", new Blob([buffer], { type: "image/png" }), filename);

  console.log(
    `Testing upload with ${isCorrupted ? "CORRUPTED" : "VALID"} image: ${filename}`,
  );
  try {
    const response = await fetch("http://localhost:3001/api/upload", {
      method: "POST",
      body: formData,
    });

    // We get text first to avoid JSON parse errors
    const text = await response.text();
    console.log(`Status: ${response.status}`);

    try {
      const result = JSON.parse(text);
      console.log(`Result: ${JSON.stringify(result, null, 2)}`);
    } catch {
      console.log(`Result text: ${text}`);
    }
    console.log("---");
  } catch (err) {
    console.error(`Error: ${err}`);
  }
}

async function runTests() {
  await testUpload("valid.png", false);
  await testUpload("corrupted.png", true);
}

runTests();
