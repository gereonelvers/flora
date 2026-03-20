# 4. Plant Stress and Response Guide for Autonomous Greenhouse Systems
## 4.1 Purpose
This document describes major abiotic stressors relevant to a Martian controlled-environment greenhouse, including:
* Physiological mechanisms
* Observable symptoms
* Impact on crop yield and nutritional value
* Mitigation strategies within a controlled agriculture system
The objective is to support AI agents in:
* Detecting plant stress conditions
* Diagnosing probable causes
* Triggering corrective environmental or nutritional actions
* Optimizing long-term crop stability and yield
---
# 4.2 Overview of Abiotic Stress in Controlled Environments
Abiotic stress refers to negative impacts on plant growth caused by non-living environmental factors.
Primary stress categories relevant to Mars greenhouse systems:
1. Water Stress (Drought or Overwatering)
2. Salinity Stress
3. Temperature Stress (Heat or Cold)
4. Nutrient Deficiency or Toxicity
5. Light Stress (Insufficient or Excessive Radiation)
6. CO₂ Imbalance
7. Hypoxia (Low Root Oxygen)
Each stress type affects:
* Photosynthesis efficiency
* Biomass accumulation
* Reproductive development
* Nutrient composition
* Harvest index
---
# 4.3 Water Stress
## 4.3.1 Drought Stress
### Physiological Mechanism
When water availability decreases:
* Stomata close to reduce transpiration
* CO₂ intake decreases
* Photosynthesis rate declines
* Cellular turgor pressure decreases
* Growth rate slows
Prolonged drought leads to:
* Reduced leaf expansion
* Reduced root and shoot biomass
* Lower yield
---
### Observable Symptoms
* Leaf wilting
* Reduced leaf size
* Leaf curling
* Slowed growth rate
* Increased root-to-shoot ratio
---
### Impact on Crops
| Crop Type | Sensitivity Level |
| - | - |
| Lettuce | High |
| Radish | Moderate |
| Beans/Peas | Moderate |
| Potatoes | Moderate to High |
Leafy greens are particularly sensitive due to high water content.
---
### Mitigation in CEA Context
* Increase irrigation frequency
* Adjust nutrient solution flow rate
* Increase humidity to reduce transpiration
* Reduce light intensity temporarily to reduce evaporative demand
---
## 4.3.2 Overwatering / Waterlogging
### Mechanism
Excess water reduces oxygen availability in the root zone.
* Root respiration decreases
* Root rot risk increases
* Nutrient uptake declines
---
### Observable Symptoms
* Yellowing leaves (chlorosis)
* Slowed growth
* Root discoloration
* Increased fungal risk
---
### Mitigation
* Improve drainage (hydroponic flow adjustment)
* Increase root oxygenation (aeration systems)
* Reduce irrigation cycle duration
---
# 4.4 Salinity Stress
Relevant if nutrient solution becomes concentrated due to evaporation.
## Mechanism
High salt concentration:
* Increases osmotic pressure
* Reduces water uptake
* Causes ion toxicity (Na⁺, Cl⁻ excess)
---
## Observable Symptoms
* Leaf edge burn
* Reduced leaf expansion
* Stunted growth
---
## Impact on Yield
Can reduce biomass accumulation by 20–50% depending on severity.
---
## Mitigation
* Dilute nutrient solution
* Monitor electrical conductivity (EC)
* Implement closed-loop filtration
---
# 4.5 Temperature Stress
## 4.5.1 Heat Stress
### Mechanism
Above optimal range:
* Protein denaturation
* Reduced photosynthetic efficiency
* Increased respiration rate
* Accelerated flowering (bolting in lettuce)
---
### Observable Symptoms
* Leaf tip burn
* Premature flowering
* Reduced leaf mass
* Lower tuber size (potatoes)
---
### Critical Thresholds (Approximate)
| Crop | Heat Risk Above |
| - | - |
| Lettuce | 25°C |
| Radish | 26°C |
| Beans | 30°C |
| Potatoes | 25–28°C |
---
### Mitigation
* Increase ventilation
* Reduce LED intensity
* Increase evaporative cooling
* Adjust planting density
---
## 4.5.2 Cold Stress
### Mechanism
Below optimal range:
* Reduced enzyme activity
* Slower metabolism
* Delayed growth cycle
---
### Symptoms
* Purple leaf coloration
* Reduced root development
* Extended time to harvest
---
### Mitigation
* Increase heating
* Optimize insulation
* Adjust photoperiod
---
# 4.6 Nutrient Deficiency
Precise nutrient control is critical in hydroponic systems.
---
## 4.6.1 Nitrogen (N) Deficiency
### Symptoms
* Yellowing of older leaves
* Reduced growth rate
* Lower protein content
### Impact
* Reduced leaf biomass
* Reduced nutritional value (protein)
### Mitigation
* Increase nitrogen concentration in nutrient solution
* Monitor nitrate levels
---
## 4.6.2 Potassium (K) Deficiency
### Symptoms
* Leaf edge browning
* Weak stems
* Reduced tuber size (potatoes)
### Mitigation
* Adjust K concentration
* Monitor solution EC
---
## 4.6.3 Iron (Fe) Deficiency
### Symptoms
* Yellowing of young leaves (interveinal chlorosis)
Common in high pH systems.
### Mitigation
* Adjust pH (optimal 5.5–6.5)
* Add chelated iron
---
# 4.7 Light Stress
## Insufficient Light
### Mechanism
* Reduced photosynthesis
* Reduced carbohydrate production
### Symptoms
* Elongated stems (etiolation)
* Pale leaves
* Lower biomass
### Mitigation
* Increase LED intensity
* Adjust photoperiod duration
---
## Excessive Light
### Mechanism
* Photoinhibition
* Chlorophyll damage
### Symptoms
* Leaf bleaching
* Burn spots
### Mitigation
* Reduce intensity
* Adjust light spectrum
---
# 4.8 CO₂ Imbalance
## Low CO₂
* Reduced photosynthesis
* Slower growth
## Excess CO₂ (>1500 ppm)
* May stress some species
* Must remain safe for astronauts
Optimal range for most crops:
800–1200 ppm
---
# 4.9 Root Hypoxia
Low oxygen in root zone (common in poorly managed hydroponics).
### Symptoms
* Root browning
* Reduced nutrient uptake
* Wilting despite adequate moisture
### Mitigation
* Increase aeration
* Improve circulation
---
# 4.10 AI-Oriented Stress Response Logic
For autonomous systems, stress management follows:
1. Detect anomaly (sensor data)
2. Match symptoms to probable stressor
3. Validate via secondary indicators
4. Trigger corrective action
5. Monitor recovery trend
Example:
IF:
* Soil moisture ↓
* Leaf wilting ↑
* Growth rate ↓
THEN:
* Diagnose drought stress
* Increase irrigation
* Temporarily reduce light intensity
---
# 4.11 Yield Impact Hierarchy
Not all stress types equally threaten mission success.
High-risk stress:
* Severe water deficit
* Nutrient deficiency (N)
* Temperature instability
Moderate risk:
* Light imbalance
* CO₂ fluctuation
Low risk (short-term):
* Minor salinity fluctuation
AI agents should prioritize interventions accordingly.
