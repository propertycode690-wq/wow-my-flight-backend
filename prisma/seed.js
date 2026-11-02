/**
 * prisma/seed.js
 * Comprehensive Seed script for WowMyFlight CRM PostgreSQL Database
 */

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Starting comprehensive database seed for WowMyFlight CRM...');

  // 1. Users / Agents (Core Main Company Personnel)
  const users = [
    {
      id: 'usr-super-admin',
      name: 'Wael Madi (CEO)',
      email: 'wael.madi@wowmyflight.com',
      passwordHash: 'password123',
      role: 'super_admin',
      phone: '+18333955554',
      avatar: 'https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?w=150',
      status: 'active'
    },
    {
      id: 'usr-admin',
      name: 'Alex Turner (GM)',
      email: 'admin@wowmyflight.com',
      passwordHash: 'password123',
      role: 'admin',
      phone: '+18503329680',
      avatar: 'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=150',
      status: 'active'
    },
    {
      id: 'usr-consultant',
      name: 'Sofia Rodriguez (Sales)',
      email: 'sales@wowmyflight.com',
      passwordHash: 'password123',
      role: 'consultant',
      phone: '+18503329681',
      avatar: 'https://images.unsplash.com/photo-1580489944761-15a19d654956?w=150',
      status: 'active'
    }
  ];

  for (const u of users) {
    await prisma.user.upsert({
      where: { id: u.id },
      update: {
        name: u.name,
        email: u.email,
        passwordHash: u.passwordHash,
        role: u.role,
        phone: u.phone,
        avatar: u.avatar,
        status: u.status
      },
      create: u
    });
  }
  console.log(`✅ Seeded ${users.length} full-role team users in PostgreSQL`);

  // 2. Clients (Confirmed Travelers)
  const clientCount = await prisma.client.count();
  if (clientCount === 0) {
    await prisma.client.createMany({
      data: [
        {
          id: 'CL-101',
          firstName: 'Marcus',
          lastName: 'Vance',
          email: 'marcus.vance@example.com',
          phone: '+1 415 555 2671',
          nationality: 'United States',
          tier: 'VIP Platinum',
          totalSpent: 12450.00,
          status: 'Active'
        },
        {
          id: 'CL-102',
          firstName: 'Amina',
          lastName: 'Al-Mansoor',
          email: 'amina.m@example.ae',
          phone: '+971 50 123 4567',
          nationality: 'United Arab Emirates',
          tier: 'Gold',
          totalSpent: 8790.00,
          status: 'Active'
        },
        {
          id: 'CL-103',
          firstName: 'Liam',
          lastName: 'O\'Connor',
          email: 'liam.oc@example.ie',
          phone: '+353 87 987 6543',
          nationality: 'Ireland',
          tier: 'Standard',
          totalSpent: 3200.00,
          status: 'Active'
        }
      ]
    });
    console.log('✅ Sample confirmed clients seeded');
  }

  // 3. Quotes (Flight Proposals)
  const quoteCount = await prisma.quote.count();
  if (quoteCount === 0) {
    await prisma.quote.createMany({
      data: [
        {
          quoteId: 'QT-9001',
          customerName: 'Marcus Vance',
          customerEmail: 'marcus.vance@example.com',
          customerPhone: '+1 415 555 2671',
          status: 'Sent',
          origin: 'JFK',
          destination: 'LHR',
          tripType: 'Round Trip',
          cabinClass: 'Club World (Business)',
          passengers: 2,
          departureDate: '2026-11-15',
          returnDate: '2026-11-28',
          airline: 'British Airways',
          flightNumber: 'BA 178 / BA 117',
          totalPrice: 7700.00,
          netPrice: 6400.00,
          markup: 1100.00,
          serviceFee: 200.00,
          currency: 'USD',
          validUntil: '24 hours',
          notes: 'Customer requested 180° lie-flat bed with fast-track lounge pass.'
        },
        {
          quoteId: 'QT-9002',
          customerName: 'Amina Al-Mansoor',
          customerEmail: 'amina.m@example.ae',
          customerPhone: '+971 50 123 4567',
          status: 'Accepted',
          origin: 'DXB',
          destination: 'CDG',
          tripType: 'Round Trip',
          cabinClass: 'First Class',
          passengers: 1,
          departureDate: '2026-12-01',
          returnDate: '2026-12-10',
          airline: 'Emirates',
          flightNumber: 'EK 073 / EK 076',
          totalPrice: 6250.00,
          netPrice: 5300.00,
          markup: 850.00,
          serviceFee: 100.00,
          currency: 'USD',
          validUntil: '48 hours',
          notes: 'Direct flight, private suite with shower spa.'
        },
        {
          quoteId: 'QT-9003',
          customerName: 'Liam O\'Connor',
          customerEmail: 'liam.oc@example.ie',
          customerPhone: '+353 87 987 6543',
          status: 'Draft',
          origin: 'DUB',
          destination: 'BOM',
          tripType: 'One Way',
          cabinClass: 'Economy',
          passengers: 3,
          departureDate: '2026-11-20',
          returnDate: null,
          airline: 'Qatar Airways',
          flightNumber: 'QR 018 / QR 556',
          totalPrice: 2890.00,
          netPrice: 2450.00,
          markup: 380.00,
          serviceFee: 60.00,
          currency: 'USD',
          validUntil: '12 hours',
          notes: 'Family travel with infant bassinet request.'
        }
      ]
    });
    console.log('✅ Sample quotes seeded');
  }

  // 4. Payments & Invoices
  const paymentCount = await prisma.payment.count();
  if (paymentCount === 0) {
    await prisma.payment.createMany({
      data: [
        {
          invoiceNumber: 'INV-4401',
          customerName: 'Marcus Vance',
          customerEmail: 'marcus.vance@example.com',
          customerPhone: '+1 415 555 2671',
          amount: 7700.00,
          currency: 'USD',
          status: 'Paid',
          method: 'Stripe (Credit Card)',
          serviceName: 'Business Class Flight JFK ⇄ LHR',
          dueDate: '2026-11-01',
          paidAt: new Date(),
          paymentLink: 'https://pay.wowmyflight.com/INV-4401',
          transactionId: 'txn_stripe_987263518'
        },
        {
          invoiceNumber: 'INV-4402',
          customerName: 'Amina Al-Mansoor',
          customerEmail: 'amina.m@example.ae',
          customerPhone: '+971 50 123 4567',
          amount: 6250.00,
          currency: 'USD',
          status: 'Paid',
          method: 'Tamara (Installments)',
          serviceName: 'Emirates First Suite DXB ⇄ CDG',
          dueDate: '2026-11-05',
          paidAt: new Date(),
          paymentLink: 'https://pay.wowmyflight.com/INV-4402',
          transactionId: 'txn_tamara_88492019'
        },
        {
          invoiceNumber: 'INV-4403',
          customerName: 'Liam O\'Connor',
          customerEmail: 'liam.oc@example.ie',
          customerPhone: '+353 87 987 6543',
          amount: 2890.00,
          currency: 'USD',
          status: 'Pending',
          method: 'Visa / Mastercard',
          serviceName: 'Flight Tickets DUB → BOM',
          dueDate: '2026-11-18',
          paidAt: null,
          paymentLink: 'https://pay.wowmyflight.com/INV-4403',
          transactionId: null
        }
      ]
    });
    console.log('✅ Sample invoices & payments seeded');
  }

  // 5. Consultations
  const consCount = await prisma.consultation.count();
  if (consCount === 0) {
    await prisma.consultation.createMany({
      data: [
        {
          clientName: 'Marcus Vance',
          clientEmail: 'marcus.vance@example.com',
          clientPhone: '+1 415 555 2671',
          agentName: 'Sarah Jenkins',
          serviceType: 'Corporate & First Class Itinerary Planning',
          dateTime: '2026-11-12T14:00:00Z',
          status: 'Scheduled',
          meetingLink: 'https://meet.google.com/wmf-mvance-plan',
          notes: 'Review European connections and lounge access.'
        },
        {
          clientName: 'Dr. Rahul Mehta',
          clientEmail: 'rahul.m@example.in',
          clientPhone: '+91 98200 12345',
          agentName: 'Elena Rostova',
          serviceType: 'Medical Conference Multi-City Flight Routing',
          dateTime: '2026-11-14T10:30:00Z',
          status: 'Scheduled',
          meetingLink: 'https://meet.google.com/wmf-rmehta-conf',
          notes: 'BOM → FRA → ORD → BOM multi-leg route consultation.'
        }
      ]
    });
    console.log('✅ Sample consultations seeded');
  }

  // 6. Documents
  const docCount = await prisma.document.count();
  if (docCount === 0) {
    await prisma.document.createMany({
      data: [
        {
          customerName: 'Marcus Vance',
          fileName: 'US_Passport_MarcusVance.pdf',
          fileType: 'application/pdf',
          fileSize: '2.4 MB',
          category: 'Passport',
          status: 'Verified',
          fileUrl: 'https://storage.wowmyflight.com/docs/us_pass_mv.pdf',
          comment: 'Passport validity exceeds 6 months. Approved.',
          reviewedBy: 'David Smith',
          reviewedAt: new Date()
        },
        {
          customerName: 'Amina Al-Mansoor',
          fileName: 'Schengen_Visa_Amina.pdf',
          fileType: 'application/pdf',
          fileSize: '1.8 MB',
          category: 'Visa',
          status: 'Verified',
          fileUrl: 'https://storage.wowmyflight.com/docs/schengen_amina.pdf',
          comment: 'Multiple entry French Schengen visa valid until 2027.',
          reviewedBy: 'Sarah Jenkins',
          reviewedAt: new Date()
        },
        {
          customerName: 'Liam O\'Connor',
          fileName: 'Irish_Passport_Liam.pdf',
          fileType: 'application/pdf',
          fileSize: '1.1 MB',
          category: 'Passport',
          status: 'Pending',
          fileUrl: 'https://storage.wowmyflight.com/docs/irish_pass_liam.pdf',
          comment: 'Submitted for verification.'
        }
      ]
    });
    console.log('✅ Sample traveler documents seeded');
  }

  console.log('🎉 WowMyFlight PostgreSQL database seeding completed!');
}

main()
  .catch((e) => {
    console.error('❌ Seed error:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
