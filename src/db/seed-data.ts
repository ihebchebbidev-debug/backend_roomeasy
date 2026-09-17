/**
 * Reference data the application needs in order to behave correctly, and a
 * small set of demo accounts for local development.
 *
 * Everything here is inserted idempotently (`ON CONFLICT DO UPDATE/NOTHING`),
 * so the seed can be re-run at any time without creating duplicates.
 */

export type EquipmentSeed = {
  id: string;
  group:
    | "general"
    | "wellness"
    | "food"
    | "activities"
    | "transport"
    | "services"
    | "family"
    | "safety"
    | "cleaning"
    | "access";
  labelEn: string;
  labelFr: string;
  paid?: boolean;
};

/** The amenity catalogue shown in the listing wizard and the search filters. */
export const EQUIPMENT_SEED: EquipmentSeed[] = [
  { id: "wifi", group: "general", labelEn: "Wi-Fi", labelFr: "Wi-Fi" },
  { id: "tv", group: "general", labelEn: "Television", labelFr: "Télévision" },
  { id: "airConditioning", group: "general", labelEn: "Air conditioning", labelFr: "Climatisation" },
  { id: "heating", group: "general", labelEn: "Heating", labelFr: "Chauffage" },
  { id: "workspace", group: "general", labelEn: "Dedicated workspace", labelFr: "Espace de travail" },
  { id: "balcony", group: "general", labelEn: "Balcony", labelFr: "Balcon" },
  { id: "garden", group: "general", labelEn: "Garden", labelFr: "Jardin" },
  { id: "fireplace", group: "general", labelEn: "Fireplace", labelFr: "Cheminée" },

  { id: "pool", group: "wellness", labelEn: "Swimming pool", labelFr: "Piscine" },
  { id: "hotTub", group: "wellness", labelEn: "Hot tub", labelFr: "Jacuzzi" },
  { id: "sauna", group: "wellness", labelEn: "Sauna", labelFr: "Sauna" },
  { id: "gym", group: "wellness", labelEn: "Gym", labelFr: "Salle de sport" },
  { id: "spa", group: "wellness", labelEn: "Spa access", labelFr: "Accès spa", paid: true },

  { id: "kitchen", group: "food", labelEn: "Kitchen", labelFr: "Cuisine" },
  { id: "coffeeMachine", group: "food", labelEn: "Coffee machine", labelFr: "Machine à café" },
  { id: "dishwasher", group: "food", labelEn: "Dishwasher", labelFr: "Lave-vaisselle" },
  { id: "barbecue", group: "food", labelEn: "Barbecue", labelFr: "Barbecue" },
  { id: "breakfast", group: "food", labelEn: "Breakfast included", labelFr: "Petit-déjeuner inclus", paid: true },

  { id: "beachAccess", group: "activities", labelEn: "Beach access", labelFr: "Accès plage" },
  { id: "skiInOut", group: "activities", labelEn: "Ski-in / ski-out", labelFr: "Skis aux pieds" },
  { id: "bikes", group: "activities", labelEn: "Bikes available", labelFr: "Vélos disponibles" },
  { id: "gameRoom", group: "activities", labelEn: "Game room", labelFr: "Salle de jeux" },

  { id: "parking", group: "transport", labelEn: "Free parking", labelFr: "Parking gratuit" },
  { id: "paidParking", group: "transport", labelEn: "Paid parking", labelFr: "Parking payant", paid: true },
  { id: "evCharger", group: "transport", labelEn: "EV charger", labelFr: "Borne de recharge" },
  { id: "airportShuttle", group: "transport", labelEn: "Airport shuttle", labelFr: "Navette aéroport", paid: true },

  { id: "selfCheckIn", group: "services", labelEn: "Self check-in", labelFr: "Arrivée autonome" },
  { id: "concierge", group: "services", labelEn: "Concierge", labelFr: "Conciergerie", paid: true },
  { id: "laundry", group: "services", labelEn: "Washing machine", labelFr: "Lave-linge" },
  { id: "dryer", group: "services", labelEn: "Dryer", labelFr: "Sèche-linge" },
  { id: "luggageDropOff", group: "services", labelEn: "Luggage drop-off", labelFr: "Dépôt de bagages" },

  { id: "crib", group: "family", labelEn: "Crib", labelFr: "Lit bébé" },
  { id: "highChair", group: "family", labelEn: "High chair", labelFr: "Chaise haute" },
  { id: "petFriendly", group: "family", labelEn: "Pets allowed", labelFr: "Animaux acceptés" },
  { id: "childSafety", group: "family", labelEn: "Child safety gates", labelFr: "Barrières de sécurité" },

  { id: "smokeAlarm", group: "safety", labelEn: "Smoke alarm", labelFr: "Détecteur de fumée" },
  { id: "carbonMonoxideAlarm", group: "safety", labelEn: "Carbon monoxide alarm", labelFr: "Détecteur de CO" },
  { id: "fireExtinguisher", group: "safety", labelEn: "Fire extinguisher", labelFr: "Extincteur" },
  { id: "firstAidKit", group: "safety", labelEn: "First aid kit", labelFr: "Trousse de secours" },
  { id: "securityCameras", group: "safety", labelEn: "Exterior security cameras", labelFr: "Caméras extérieures" },

  { id: "cleaningService", group: "cleaning", labelEn: "Mid-stay cleaning", labelFr: "Ménage en cours de séjour", paid: true },
  { id: "linenProvided", group: "cleaning", labelEn: "Linen provided", labelFr: "Linge fourni" },
  { id: "toiletries", group: "cleaning", labelEn: "Toiletries", labelFr: "Produits de toilette" },

  { id: "elevator", group: "access", labelEn: "Elevator", labelFr: "Ascenseur" },
  { id: "stepFreeAccess", group: "access", labelEn: "Step-free access", labelFr: "Accès de plain-pied" },
  { id: "wideDoorway", group: "access", labelEn: "Wide doorways", labelFr: "Portes larges" },
  { id: "groundFloor", group: "access", labelEn: "Ground floor", labelFr: "Rez-de-chaussée" },
];

/** Demo logins created only when `SEED_DEMO_ACCOUNTS` is on. */
export const DEMO_ACCOUNTS = [
  { fullName: "Platform Admin", email: "admin@nestara.test", password: "Admin!2345", roles: ["admin", "guest"] },
  { fullName: "Hana Host", email: "host@nestara.test", password: "Host!2345", roles: ["host", "guest"] },
  { fullName: "Gabi Guest", email: "guest@nestara.test", password: "Guest!2345", roles: ["guest"] },
] as const;
