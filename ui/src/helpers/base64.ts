/**
 * The base64 text of a Blob's bytes, for the JSON uploads the server takes
 * (`files/write-binary`, `import-file`). Reads through the browser's own
 * encoder, so a multi-megabyte picture never goes through a JS string
 * builder one byte at a time.
 */
export class Base64 {
  static fromBlob(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error ?? new Error('Could not read the file.'));
      reader.onload = () => {
        const url = String(reader.result ?? '');
        const comma = url.indexOf(',');
        resolve(comma >= 0 ? url.slice(comma + 1) : '');
      };
      reader.readAsDataURL(blob);
    });
  }
}
