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
            console.error('Error getting SendPulse token:', error.response ? error.response.data : error);
            throw error;
        }
    }

    async addDeal(phone, url) {
        try {
            const token = await this.getToken();
            
            const response = await axios.post(
                `${this.baseUrl}/crm/v1/deals`,
                {
                    pipelineId: 130957, // Убрали кавычки, т.к. должно быть числом
                    stepId: 451337, // Убрали кавычки, т.к. должно быть числом
                    name: `Лид с сайта: ${phone}`,
                    contact: {
                        name: "Новый клиент",
                        phone: phone.replace(/\D/g, '') // Удаляем все нецифровые символы из номера
                    },
                    customFields: {
                        website_url: url
                    }
                },
                {
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Content-Type': 'application/json'
                    }
                }
            );

            console.log(`✓ Successfully added deal: ${phone}`);
            return true;
        } catch (error) {
            console.error('Error adding deal to SendPulse CRM:', error.response ? error.response.data : error);
            return false;
        }
    }
}