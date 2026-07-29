import assert from "node:assert/strict";
import test from "node:test";

import { parseProductMeta } from "./worker.js";

const COUPANG_URL =
  "https://www.coupang.com/vp/products/8414405864?itemId=24331707549&vendorItemId=92706240298";

test("parses Coupang exports.sdp image and sale price", () => {
  const html = `
    <html>
      <script>
        exports.sdp = {
          "quantityBase": [{
            "price": {"originPrice": "92,000", "salePrice": "79,000"},
            "imageUrl": "https://thumbnail.coupangcdn.com/thumbnails/remote/492x492ex/image/product.jpg"
          }]
        };
      </script>
    </html>
  `;

  assert.deepEqual(parseProductMeta(html, COUPANG_URL), {
    image: "https://thumbnail.coupangcdn.com/thumbnails/remote/492x492ex/image/product.jpg",
    price: 79000,
  });
});

test("parses Coupang product markup when bootstrap state is absent", () => {
  const html = `
    <div class="prod-image">
      <img class="prod-image__detail"
        src="https://image.coupangcdn.com/image/vendor_inventory/item.webp?size=492x492&amp;quality=90">
    </div>
    <span class="total-price"><strong>73,000원</strong></span>
  `;

  assert.deepEqual(parseProductMeta(html, COUPANG_URL), {
    image:
      "https://image.coupangcdn.com/image/vendor_inventory/item.webp?size=492x492&quality=90",
    price: 73000,
  });
});

test("does not use Coupang access-denied logo as a product image", () => {
  const html = `
    <meta property="og:image"
      content="https://img2.coupangcdn.com/image/www/error/logo-coupang.gif">
  `;

  assert.deepEqual(parseProductMeta(html, COUPANG_URL), {
    image: "",
    price: null,
  });
});
