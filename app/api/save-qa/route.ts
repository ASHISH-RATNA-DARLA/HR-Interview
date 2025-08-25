import { promises as fs } from 'fs';
import { NextRequest, NextResponse } from 'next/server';
import path from 'path';

export async function POST(req: NextRequest) {
  try {
    const data = await req.json();
    const filePath = path.join(process.cwd(), 'QA.json');

    // Read existing data if file exists, otherwise initialize empty array
    let existingData: any[] = [];
    try {
      const fileContent = await fs.readFile(filePath, 'utf-8');
      try {
        existingData = JSON.parse(fileContent);
        if (!Array.isArray(existingData)) {
          console.warn('QA.json content is not an array, re-initializing.');
          existingData = []; // Ensure it's an array
        }
      } catch (jsonParseError) {
        console.error('Error parsing QA.json content, re-initializing:', jsonParseError);
        existingData = []; // Treat as empty if parsing fails
      }
    } catch (readError: any) {
      if (readError.code !== 'ENOENT') {
        console.error('Error reading QA.json (non-ENOENT):', readError);
        return NextResponse.json({ message: 'Failed to read existing QA data' }, { status: 500 });
      }
      // If file doesn't exist, existingData remains an empty array
      console.log('QA.json not found, creating new file.');
    }

    // Append new data
    existingData.push(data);

    // Write updated data back to file
    await fs.writeFile(filePath, JSON.stringify(existingData, null, 2), 'utf-8');

    return NextResponse.json({ message: 'QA data saved successfully' }, { status: 200 });
  } catch (error) {
    console.error('Error saving QA data:', error);
    return NextResponse.json({ message: 'Failed to save QA data' }, { status: 500 });
  }
}
