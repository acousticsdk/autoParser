import axios from 'axios';

export class SendPulseService {
    constructor() {
        this.clientId = process.env.SENDPULSE_CLIENT_ID;
        this.clientSecret = process.env.SENDPULSE_CLIENT_SECRET;
        this.baseUrl = 'https://api.sendpulse.com';
        this.token = null;
        this.tokenExpires = null;
    }

    async getToken() {
        if (this.token && this.tokenExpires && Date.now() < this.tokenExpires) {
            return this.token;
        }

        try {
            const response = await axios.post(`${this.baseUrl}/oauth/access_token`, {
                grant_type: 'client_credentials',
                client_id: this.clientId,
                client_secret: this.clientSecret
            });

            this.token = response.data.access_token;
            this.tokenExpires = Date.now() + (response.data.expires_in * 1000);
            return this.token;
        } catch (error) {
            console.error('Error getting SendPulse token:', error);
            throw error;
        }
    }

    async addToAutoriaFlow(phone, url) {
        try {
            const token = await this.getToken();
            
            const response = await axios.post(
                `${this.baseUrl}/automations/process`,
                {
                    flow_name: 'АВТОРІА',
                    variables: {
                        phone: phone,
                        url: url
                    }
                },
                {
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Content-Type': 'application/json'
                    }
                }
            );

            console.log(`✓ Successfully added to SendPulse flow: ${phone}`);
            return true;
        } catch (error) {
            console.error('Error adding to SendPulse flow:', error);
            return false;
        }
    }
}