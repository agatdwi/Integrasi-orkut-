// server.js
const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const session = require('express-session');
const flash = require('connect-flash');
const settings = require('./settings');

process.env.ORKUT_QRIS_STATIC_CODE = settings.ORKUT_QRIS_STATIC_CODE;
process.env.ORKUT_QRIS_FEE_PERCENTAGE = settings.ORKUT_QRIS_FEE_PERCENTAGE;
process.env.ORKUT_QRIS_FEE_BY_CUSTOMER_DEPOSIT = settings.ORKUT_QRIS_FEE_BY_CUSTOMER_DEPOSIT;
process.env.OKECONNECT_MERCHANT_ID = settings.OKECONNECT_MERCHANT_ID;
process.env.OKECONNECT_API_KEY = settings.OKECONNECT_API_KEY;
if (settings.ORKUT_QRIS_EXPIRY_MINUTES) {
    process.env.ORKUT_QRIS_EXPIRY_MINUTES = settings.ORKUT_QRIS_EXPIRY_MINUTES;
}

const { createDynamicOrkutQris, checkOrkutQrisPaymentStatus, getLatestMutations } = require('./handlerqris');

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
    secret: '583408417498686151016700OKCT23C37B0C7EC236263B1220B53B65D8F5', // GANTI INI!
    resave: false,
    saveUninitialized: true,
    cookie: { secure: process.env.NODE_ENV === 'production', httpOnly: true, maxAge: 24 * 60 * 60 * 1000 }
}));
app.use(flash());

app.use((req, res, next) => {
    res.locals.APP_NAME = settings.APP_NAME;
    res.locals.success_msg = req.flash('success_msg');
    res.locals.error_msg = req.flash('error_msg');
    next();
});

const requiredSettingsKeys = ['ORKUT_QRIS_STATIC_CODE', 'OKECONNECT_MERCHANT_ID', 'OKECONNECT_API_KEY'];
for (const key of requiredSettingsKeys) {
    if (!settings[key] || settings[key].startsWith("ISI_DENGAN_")) {
        console.error(`FATAL: Pengaturan "${key}" di settings.js belum diisi.`);
        process.exit(1);
    }
}

app.get('/', (req, res) => {
    res.render('index');
});

app.post('/donate', async (req, res) => {
    const { name, amount, message } = req.body;
    const originalAmountParam = parseFloat(amount);

    if (isNaN(originalAmountParam) || originalAmountParam < 1000) {
        req.flash('error_msg', 'Jumlah donasi minimal IDR 1,000.');
        return res.redirect('/');
    }

    try {
        const transactionName = name ? `Donasi ${name}` : `Donasi ${settings.APP_NAME}`;
        const qrisResult = await createDynamicOrkutQris(originalAmountParam, transactionName);
        
        if (qrisResult.success) {
            const donationData = {
                ...qrisResult,
                name_display: name ? name.trim() : "Donatur",
                message_display: message ? message.trim() : ""
            };
            req.session.lastDonation = {
                orkutReffId: donationData.orkutReffId,
                amountToPayWithFee: donationData.amountToPayWithFee,
                generatedAt: Date.now()
            };
            res.render('processing', { donation: donationData });
        } else {
            req.flash('error_msg', qrisResult.message || 'Gagal memproses donasi.');
            res.redirect('/');
        }
    } catch (error) {
        req.flash('error_msg', `Kesalahan sistem: ${error.message}.`);
        res.redirect('/');
    }
});

app.get('/mutations', async (req, res) => {
    try {
        const mutationData = await getLatestMutations();
        res.render('mutations', { mutationData });
    } catch (error) {
        res.render('mutations', { 
            mutationData: `Gagal ambil data mutasi: ${error.message}`,
            error_msg: ['Kesalahan sistem saat ambil mutasi.'] 
        });
    }
});

app.get('/status/:orderReffId/:amountExpected', async (req, res) => {
    const { orderReffId, amountExpected } = req.params;
    const parsedAmount = parseInt(amountExpected);

    if (!orderReffId || isNaN(parsedAmount)) {
        req.flash('error_msg', 'Parameter cek status tidak valid.');
        return res.redirect('/');
    }
    
    const lastCheckedTimestamp = (req.session.lastDonation && req.session.lastDonation.orkutReffId === orderReffId)
                               ? req.session.lastDonation.generatedAt : null;

    try {
        const statusResult = await checkOrkutQrisPaymentStatus(orderReffId, parsedAmount, lastCheckedTimestamp);
        
        if (statusResult.success && statusResult.isPaid) {
            req.flash('success_msg', `Pembayaran ID ${orderReffId} (Rp ${parsedAmount.toLocaleString('id-ID')}) DITERIMA!`);
            if (req.session.lastDonation && req.session.lastDonation.orkutReffId === orderReffId) delete req.session.lastDonation;
        } else if (statusResult.success && !statusResult.isPaid) {
            req.flash('error_msg', `Pembayaran ID ${orderReffId} (Rp ${parsedAmount.toLocaleString('id-ID')}) BELUM DITEMUKAN. ${statusResult.message || ''}`);
        } else { 
            req.flash('error_msg', `Gagal cek status ID ${orderReffId}: ${statusResult.message || 'Error.'}`);
        }
        res.redirect('/');
    } catch (error) {
        req.flash('error_msg', `Kesalahan sistem cek status: ${error.message}`);
        res.redirect('/');
    }
});

app.use((req, res, next) => {
    res.status(404).render('error', { message: 'Halaman tidak ditemukan (404).' });
});

app.use((err, req, res, next) => {
    console.error("Unhandled Server Error:", err.stack || err);
    res.status(500).render('error', { message: 'Kesalahan internal server (500).' });
});

app.listen(settings.PORT, () => {
    console.log(`Server ${settings.APP_NAME} berjalan di http://localhost:${settings.PORT}`);
});
