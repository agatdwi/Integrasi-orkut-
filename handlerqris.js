const axios = require("axios");
const FormData = require("form-data");
const QRCode = require("qrcode");
const { Readable } = require("stream");

// Fungsi untuk menghitung CRC16
function convertCRC16(payload) {
  let crc = 0xffff;
  for (let i = 0; i < payload.length; i++) {
    crc ^= payload.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) {
      crc = (crc & 0x8000) ? (crc << 1) ^ 0x1021 : crc << 1;
    }
  }
  return ("000" + (crc & 0xffff).toString(16).toUpperCase()).slice(-4);
}

// ID Transaksi unik
function generateTransactionId(prefix = "QRIS") {
  const timePart = Date.now().toString().slice(-5);
  const randomPart = Math.random().toString(36).substring(2, 7).toUpperCase();
  return `${prefix}${timePart}${randomPart}`;
}

// Waktu kadaluarsa
function generateExpirationTime(minutes = parseInt(process.env.ORKUT_QRIS_EXPIRY_MINUTES) || 15) {
  const expiry = new Date();
  expiry.setMinutes(expiry.getMinutes() + minutes);
  return expiry;
}

// Buffer ke stream
async function bufferToStream(buffer) {
  const stream = new Readable();
  stream.push(buffer);
  stream.push(null);
  return stream;
}

// Upload QR ke Catbox
async function uploadQrToCatbox(buffer) {
  try {
    const form = new FormData();
    form.append("reqtype", "fileupload");
    const stream = await bufferToStream(buffer);
    form.append("fileToUpload", stream, {
      filename: "qr_orkut_" + Date.now() + ".png",
      contentType: "image/png"
    });

    const response = await axios.post("https://catbox.moe/user/api.php", form, {
      headers: form.getHeaders(),
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      timeout: 15000
    });

    if (!response.data || typeof response.data !== "string" || !response.data.startsWith("http")) {
      throw new Error("Gagal mengunggah QR ke Catbox.");
    }

    return response.data;
  } catch (err) {
    console.error("Upload error:", err.message);
    throw err;
  }
}

// Buat QRIS Dinamis
async function createDynamicOrkutQris(amount, note = "Pembayaran") {
  try {
    const baseQris = process.env.ORKUT_QRIS_STATIC_CODE;
    const feePercent = parseFloat(process.env.ORKUT_QRIS_FEE_PERCENTAGE_FOR_DEPOSIT || process.env.ORKUT_QRIS_FEE_PERCENTAGE || 0.7);
    const feeByCustomer = process.env.ORKUT_QRIS_FEE_BY_CUSTOMER_DEPOSIT === "true";

    if (!baseQris) throw new Error("QRIS statis belum dikonfigurasi.");
    const parsedAmount = parseInt(amount);
    if (isNaN(parsedAmount) || parsedAmount <= 0) throw new Error("Jumlah tidak valid.");

    let finalAmount = parsedAmount;
    let feeAmount = 0;

    if (feeByCustomer && feePercent > 0) {
      feeAmount = Math.ceil(parsedAmount * (feePercent / 100));
      finalAmount += feeAmount;
    } else if (!feeByCustomer && feePercent > 0) {
      feeAmount = Math.ceil(parsedAmount * (feePercent / 100));
    }

    let modifiedQris = baseQris;
    if (modifiedQris.length > 12 && modifiedQris.substring(6, 12) === "010211") {
      modifiedQris = modifiedQris.substring(0, 6) + "010212" + modifiedQris.substring(12);
    }

    const marker = "5802ID";
    const markerIndex = modifiedQris.indexOf(marker);
    if (markerIndex === -1) throw new Error("Format QRIS tidak valid (5802ID tidak ditemukan).");

    const qrisHead = modifiedQris.substring(0, markerIndex);
    const qrisTail = modifiedQris.substring(markerIndex);
    const amountStr = finalAmount.toString();
    const amountField = "54" + ("0" + amountStr.length).slice(-2) + amountStr;
    const qrisPayload = qrisHead + amountField + qrisTail;
    const payloadWithoutCRC = qrisPayload.slice(0, -4);
    const crc = convertCRC16(payloadWithoutCRC);
    const finalPayload = payloadWithoutCRC + crc;

    const qrBuffer = await QRCode.toBuffer(finalPayload, {
      errorCorrectionLevel: "M",
      type: "png",
      margin: 2,
      width: 300,
      color: { dark: "#000000", light: "#FFFFFF" }
    });

    const imageUrl = await uploadQrToCatbox(qrBuffer);
    const transactionId = generateTransactionId("ORD");
    const expiration = generateExpirationTime();

    return {
      success: true,
      orkutReffId: transactionId,
      amountToPayWithFee: finalAmount,
      originalAmount: parsedAmount,
      feeAmount,
      qrImageUrl: imageUrl,
      qrString: finalPayload,
      expiredAt: expiration,
      paymentMethod: "ORKUT_QRIS",
      message: "QRIS berhasil dibuat."
    };
  } catch (err) {
    console.error("Gagal membuat QRIS:", err.message);
    return {
      success: false,
      message: err.message || "Gagal membuat QRIS Orkut."
    };
  }
}

// Cek status pembayaran QRIS
async function checkOrkutQrisPaymentStatus(transactionId, amount, expiredAt) {
  try {
    const merchantId = process.env.OKECONNECT_MERCHANT_ID;
    const apiKey = process.env.OKECONNECT_API_KEY;
    if (!merchantId || !apiKey) {
      return { success: false, isPaid: false, message: "Konfigurasi OkeConnect tidak lengkap." };
    }

    const fallbackMinutes = 30;
    const minDate = new Date(Date.now() - fallbackMinutes * 60 * 1000);
    const startDate = expiredAt ? new Date(Math.max(expiredAt, minDate.getTime())) : minDate;
    const formattedDate = startDate.toISOString().split("T")[0];

    const url = `https://gateway.okeconnect.com/api/mutasi/qris/${merchantId}/${apiKey}?date_from=${formattedDate}`;
    const response = await axios.get(url, { timeout: 15000 });

    if (response.data?.status === "success" && Array.isArray(response.data.data)) {
      const matchSuffix = transactionId.toUpperCase().slice(-8);
      const matched = response.data.data.find(item => {
        return parseInt(item.amount) === amount && item.note?.toUpperCase().includes(matchSuffix);
      });

      if (matched) {
        return { success: true, isPaid: true, transaction: matched, message: "Pembayaran ditemukan." };
      } else {
        return { success: true, isPaid: false, message: "Pembayaran belum ditemukan." };
      }
    } else {
      return { success: false, isPaid: false, message: "Gagal ambil data dari OkeConnect." };
    }
  } catch (err) {
    const msg = err.response?.data?.msg ? `OkeConnect: ${err.response.data.msg}` : err.message;
    return { success: false, isPaid: false, message: msg };
  }
}

// Ambil mutasi terakhir
async function getLatestMutations() {
  try {
    const merchantId = process.env.OKECONNECT_MERCHANT_ID;
    const apiKey = process.env.OKECONNECT_API_KEY;
    if (!merchantId || !apiKey) return "Konfigurasi tidak lengkap.";

    const url = `https://gateway.okeconnect.com/api/mutasi/qris/${merchantId}/${apiKey}`;
    const res = await axios.get(url, { timeout: 15000 });

    const data = res.data;
    let message = "*Mutasi Terakhir*\n==================\n\n";

    if (data.status?.toLowerCase() === "failed" && data.msg) {
      message += `❌ Error API: ${data.msg}\n`;
    } else if (!data.data || data.data.length === 0) {
      message += `ℹ️ Tidak ada data mutasi terbaru.${data.msg ? " (" + data.msg + ")" : ""}`;
    } else {
      data.data.slice(0, 10).forEach(item => {
        message += `📅 ${item.date}\n🏦 ${item.brand_name}\n💰 Rp ${parseInt(item.amount).toLocaleString("id-ID")}\n`;
        if (item.note) message += `📝 ${item.note}\n`;
        message += "------------------\n";
      });
      if (data.data.length > 10) {
        message += `\n... ${data.data.length - 10} lainnya.`;
      }
    }
    return message;
  } catch (err) {
    let errorMsg = "❌ Gagal ambil mutasi.";
    if (err.response?.data?.msg) {
      errorMsg += ` API: ${err.response.data.msg} (${err.response.status})`;
    } else if (err.message) {
      errorMsg += ` Detail: ${err.message}`;
    }
    return errorMsg;
  }
}

module.exports = {
  createDynamicOrkutQris,
  checkOrkutQrisPaymentStatus,
  getLatestMutations
};
