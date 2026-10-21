// mega/far-code's tables: 5 × 26,000 bytes in .fini8, which the linker places after all other
// code (the .finiN sections end .text; .fini8 precedes .fini7, where farFunction lives).
#define FAR __attribute__((section(".fini8"), used))

const unsigned char table0[26000] FAR = {[0] = 0x10, [25999] = 0x1F};
const unsigned char table1[26000] FAR = {[0] = 0x20, [25999] = 0x2F};
const unsigned char table2[26000] FAR = {[0] = 0x30, [25999] = 0x3F};
const unsigned char table3[26000] FAR = {[0] = 0x40, [25999] = 0x4F};
const unsigned char table4[26000] FAR = {[0] = 0x50, [25999] = 0x5F};
