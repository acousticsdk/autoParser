import axios from 'axios';

export class SMSService {
    constructor() {
        this.token = 'WvY_VaI-6iXSWRn';
        this.sender = 'AUTO';
        this.baseUrl = 'https://im.smsclub.mobi/sms/send';
    }

    async sendSMS(phoneNumbers, messageText) {
        try {
            const response = await axios.post(
                this.baseUrl,
                {
                    phone: phoneNumbers,
                    message: messageText,
                    src_addr: this.sender
                },
                {
                    headers: {
                        'Authorization': `Bearer ${this.token}`,
                        'Content-Type': 'application/json'
                    }
                }
            );

            console.log(`✓ SMS sent to ${phoneNumbers.join(', ')}: "${messageText}"`);
            return response.data;
        } catch (error) {
            console.error('Error sending SMS:', error.message);
            return false;
        }
    }
}